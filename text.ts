import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as querystring from 'querystring'
import {promisify} from 'util'
const readFile = promisify(fs.readFile), writeFile = promisify(fs.writeFile)
import * as htmlSoup from 'html-soup'
import {TextNode, HtmlTag} from 'html-soup/dist/parse'
import fetch from 'node-fetch'
import * as twilio from 'twilio'
import {Alliance, TeamMatch} from './types'

//Constants to configure
const PORT = 6055 //port the server will run on; make Twilio SMS webhook to this port
const NUMBER = '+13236886055' //number to send match results from
const MATCH_RESULTS_URLS = [ //list of match results URLs for each division (look like .../cache/MatchResults_[competition]_[division].html)
	'http://scoring.ftceast.org/cache/MatchResults_East_Super-Regional_Hopper.html',
	'http://scoring.ftceast.org/cache/MatchResults_East_Super-Regional_Tesla.html'
]
const RANKING_URLS: {[division: string]: string} = { //mapping of division names to rankings URLS (look like .../cache/Rankings_[competition]_[division].html)
	Hopper: 'https://calebsander.com/uploads/1483107180/ranking_hopper_test.html', //'http://scoring.ftceast.org/cache/Rankings_East_Super-Regional_Hopper.html',
	//Tesla: 'http://scoring.ftceast.org/cache/Rankings_East_Super-Regional_Tesla.html'
}
const MATCH_CHECK_INTERVAL = 30e3 //number of ms to wait between checking for new match data

const REGISTERED_NUMBERS = './registered-numbers.json' //stores subscribers for each team (will be created if nonexistant)
const ACCOUNT_FILE = './twilio-account.json' //stores Twilio authentication data (required)
const MATCH_SCORES = './recorded-matches.json' //stores seen match results (will be created if nonexistant)
const MATCHES_DIR = './matches/' //stores teams' matches in MATCHES_DIR/[team number].json
const TEAM_NUMBER = /(\d{1,5})/ //matches team numbers in SMS requests
const STOP = 'done' //matches unsubscribe request in SMS requests
const STOP_MATCH = new RegExp(STOP, 'i')
const HELP = /\?/i //matches help request in SMS requests
const END = ' Good luck! -The GearTicks' //appended to every sent message
const RANK = 'rank' //matches rankings request in SMS requests
const RANKING = new RegExp(RANK, 'i')
const RANK_TEXT = ' Text "' + RANK + '" for rankings.'
const HELP_TEXT = 'Text "' + STOP + '" to disable.' + RANK_TEXT + END
const TIE_CHARACTER = '☯', LOSS_CHARACTER = '☠', WIN_CHARACTER = '⛄' //characters to send to represent match results
const BLUE_CHARACTER = '🔵', RED_CHARACTER = '🔴' //characters to send to represent alliance colors

interface TwilioAccountData {
	sid: string
	authToken: string
}
interface TwilioRequest {
	NumMedia: string
	From: string
	Body: string
	MessageSid: string
	[field: string]: string | undefined
}
interface RegisteredNumbers {
	[team: string]: string[]
}
interface MatchData {
	match: string
	score: string
	won: string //'R' | 'B"
	redTeams: Alliance
	blueTeams: Alliance
}
interface RecordedMatches {
	[id: string]: MatchData
}

const twilioAccount: TwilioAccountData = require(ACCOUNT_FILE)
const twilioInstance = twilio(twilioAccount.sid, twilioAccount.authToken)
let registeredNumbers: RegisteredNumbers = {} //mapping of team numbers to arrays of subscribed phone numbers
try { registeredNumbers = require(REGISTERED_NUMBERS) }
catch {}
let recordedMatches: RecordedMatches = {} //mapping of match ids to MatchDatas
try { recordedMatches = require(MATCH_SCORES) }
catch {}

/**
 * Unsubscribes a number from match result messages
 * @param from Phone number to deregister
 */
function deregister(from: string): void {
	for (const team in registeredNumbers) {
		const numbers = registeredNumbers[team]
		const index = numbers.indexOf(from)
		if (index > -1) {
			numbers.splice(index, 1)
			break
		}
	}
}
/**
 * Writes `registeredNumbers` to file
*/
function saveRegistered(): Promise<void> {
	return writeFile(REGISTERED_NUMBERS, JSON.stringify(registeredNumbers))
}
/**
 * Logs an error if it occurs and tells client that error occurred.
 * Use this anywhere where an error might be thrown while responding to SMS.
 * @param res The response object corresponding to the incoming SMS message
 */
function errorRespond(res: http.ServerResponse): (err: Error) => void {
	return (err: Error) => {
		console.error(err)
		res.end('Error occurred')
	}
}
/**
 * Sends an SMS that is not a response to an incoming SMS;
 * used for sending match results
 * @param number Phone number to send to
 * @param message Message to send
 */
function sendMessage(number: string, message: string): void {
	twilioInstance.messages.create({
		to: number,
		from: NUMBER,
		body: message
	})
		.then(() => console.log('Sent message to', number + ': "' + message + '"'))
		.catch(console.error)
}
/**
 * Texts to all subscribers to participants in a given match its result;
 * called whenever there is new match data
 * @param matchData The match information
 */
function reportNewMatch(matchData: MatchData): void {
	for (const team of matchData.redTeams.concat(matchData.blueTeams)) {
		const resultCharacter = matchResultCharacter(matchData, team)
		let response: string
		switch (resultCharacter) {
			case TIE_CHARACTER:
				response = 'TIED'
				break
			case LOSS_CHARACTER:
				response = 'LOST'
				break
			case WIN_CHARACTER:
				response = 'WON'
		}
		response! += ' match ' + matchData.match
			+ ' (' + matchData.score + '). '
			+ RANK_TEXT + END
		for (const number of registeredNumbers[team] || []) sendMessage(number, response!) //send message to all subscribers
	}
}
/**
 * Adds a match to `recordedMatches` and sends out results to subscribers,
 * if match has not already been recorded
 * @param id A unique identifier for the match
 * @param matchData The match data
 */
function recordMatch(id: string, matchData: MatchData): void {
	if (!recordedMatches[id]) {
		recordedMatches[id] = matchData
		reportNewMatch(matchData)
		console.log('New match:', id)
	}
}
/**
 * Fetches match results from all results URLs,
 * adding them to `recordedMatches`
 * and saving `recordedMatches` to file
*/
function fetchMatches(): Promise<void> {
	return Promise.all(MATCH_RESULTS_URLS.map((url, urlIndex) =>
		fetch(url)
			.then(res => res.text())
			.then(body => {
				const dom = htmlSoup.parse(body)
				const rows = [...htmlSoup.select(dom, 'tr')]
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i]
					if (!(
						(row.child as HtmlTag).type === 'td' && //skip header rows
						row.children.length === 4 //skip second (or third) rows for each match
					)) continue
					const scoreCell = (row.children[1] as HtmlTag).child
					if (!scoreCell) continue //skip unreported scores; check that this is correct
					const [score, won] = (scoreCell as TextNode).text.split(' ')
					const match = ((row.child as HtmlTag).child as TextNode).text
					const matchId = String(urlIndex) + ' ' + match //include urlIndex to distinguish same match number in different divisions
					const nextRow = rows[i + 1] //second teams on each alliance stored on next row
					recordMatch(matchId, {
						match, score, won,
						redTeams: [
							((row.children[2] as HtmlTag).child as TextNode).text,
							((nextRow.child as HtmlTag).child as TextNode).text
						],
						blueTeams: [
							((row.children[3] as HtmlTag).child as TextNode).text,
							((nextRow.children[1] as HtmlTag).child as TextNode).text
						]
					})
				}
			})
	))
		.then(() => writeFile(MATCH_SCORES, JSON.stringify(recordedMatches)))
}
/**
 * Selects recorded match results involving a given team
 * @param team The team number
 */
function getResultsForTeam(team: string): MatchData[] {
	return Object.keys(recordedMatches)
		.map(id => recordedMatches[id])
		.filter(({redTeams, blueTeams}) => redTeams.includes(team) || blueTeams.includes(team))
}
const TIE = 0, RED_WIN = 1, BLUE_WIN = 2
const xor = (a: boolean, b: boolean) => (a as any) ^ (b as any)
/**
 * Computes win/loss/tie character for given team in given match
 * @param matchData The match result
 * @param team The team number
 */
function matchResultCharacter(matchData: MatchData, team: string): typeof TIE_CHARACTER | typeof LOSS_CHARACTER | typeof WIN_CHARACTER {
	const result = getResult(matchData)
	if (result === TIE) return TIE_CHARACTER
	return xor(matchData.blueTeams.includes(team), result === BLUE_WIN) //if on blue and blue lost, then LOSS; other combinations are in XOR relationship
		? LOSS_CHARACTER
		: WIN_CHARACTER
}
/**
 * Computes whether match was tie, or whether red or blue won
 * @param match The match result
 */
function getResult(match: MatchData): typeof TIE | typeof RED_WIN | typeof BLUE_WIN {
	const [score1, score2] = match.score.split('-')
	if (score1 === score2) return TIE
	return match.won === 'R' ? RED_WIN : BLUE_WIN
}
/**
 * Handler for incoming SMS containing team number
 * @param team The team number
 * @param from The phone number of the sender
 * @param res The response object corresponding to the request
 */
function requestMatches(team: string, from: string, res: http.ServerResponse) {
	readFile(MATCHES_DIR + team + '.json', 'utf8')
		.then(matchData => {
			const matches = JSON.parse(matchData).matches as TeamMatch[]
			return fetchMatches()
				.then(() => {
					const responseLines: string[] = []
					const matchResults = getResultsForTeam(team)
					for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
						const {match, color, partner, opponents} = matches[matchIndex]
						let matchResponse = String(match)
							+ (color === 'blue' ? BLUE_CHARACTER : color === 'red' ? RED_CHARACTER : '')
							+ ' w/ ' + partner
							+ ' v. ' + opponents.join(' & ')
						if (matchIndex < matchResults.length) { //match result known
							const result = matchResults[matchIndex]
							matchResponse += ' (' + matchResultCharacter(result, team) + ' ' + result.score + ')'
						}
						responseLines.push(matchResponse)
					}
					//Add post-qualification matches
					for (let matchIndex = matches.length; matchIndex < matchResults.length; matchIndex++) {
						const result = matchResults[matchIndex]
						responseLines.push(result.match + ' (' + matchResultCharacter(result, team) + ' ' + result.score + ')')
					}
					deregister(from)
					//Must add numbers after fetching matches to avoid sending notifications for newly recorded matches
					if (!registeredNumbers[team]) registeredNumbers[team] = []
					registeredNumbers[team].push(from) //subscribe to team's matches
					responseLines.push('You will now be texted when team ' + team + "'s scores are announced. " + HELP_TEXT)
					return saveRegistered()
						.then(() => {
							res.end(responseLines.join('\n'))
							console.log('Responded')
						})
				})
				.catch(errorRespond(res))
		})
		.catch(() => res.end('Team ' + team + ' does not exist'))
}
/**
 * Gets team a given phone number is subscribed to
 * @param textNumber The phone number
 */
function getTeam(textNumber: string): string {
	for (const team in registeredNumbers) {
		if (registeredNumbers[team].includes(textNumber)) return team
	}
	return '' //fine; no teams will match
}
/**
 * Handler for incoming SMS requesting rankings
 * @param teamNumber The team number of the subscriber
 * @param res The response object corresponding to the request
 */
function requestRanking(teamNumber: string, res: http.ServerResponse) {
	Promise.all(Object.keys(RANKING_URLS).map(division =>
		fetch(RANKING_URLS[division])
			.then(res => res.text())
			.then(body => {
				const dom = htmlSoup.parse(body)
				const rows = htmlSoup.select(dom, 'tr')
				let divisionResponse = division
				for (const row of rows) {
					if (htmlSoup.select(row, 'th').size) continue //skip header row
					const [rank, team, QP, RP, matches] = [0, 1, 3, 4, 6].map(col =>
						((row.children[col] as HtmlTag).child as TextNode).text
					)
					if (Number(rank) > 10 && team !== teamNumber) continue //show first 10 teams and subscriber's team
					divisionResponse += '\n' + rank + '. ' + team
						+ ' (' + QP + ', ' + RP + ', ' + matches + ')'
				}
				return divisionResponse
			})
	))
		.then(divisionResponses => {
			res.end('(QP, RP, Matches)\n' + divisionResponses.join('\n\n') + '\n' + END.trim()) //place end text on next line
			console.log('Responded with rank')
		})
		.catch(errorRespond(res))
}

/**
 * Responds to an HTTP(S) request to the server
 * @param req Incoming HTTP message
 * @param res Corresponding HTTP response
 */
function httpRespond(req: http.IncomingMessage, res: http.ServerResponse) {
	const chunks: Buffer[] = []
	let reqLength = 0
	req
		.on('data', (chunk: Buffer) => {
			if (reqLength + chunk.length > 1e7) req.destroy() //avoid running out of memory
			chunks.push(chunk)
			reqLength += chunk.length
		})
		.on('end', () => {
			try {
				const request = querystring.parse(Buffer.concat(chunks).toString()) as TwilioRequest
				console.log(request)
				res.setHeader('Content-Type', 'text/plain; charset=UTF-8')
				if (request.NumMedia !== '0') return res.end('This is an SMS-only service')
				const {Body: body, From: from} = request
				console.log('SMS:', body)
				let teamMatch: RegExpExecArray | null
				if (RANKING.test(body)) requestRanking(getTeam(from), res)
				else if (STOP_MATCH.test(body)) {
					deregister(from)
					saveRegistered()
						.then(() => res.end('Unsubscribed'))
						.catch(errorRespond(res))
				}
				else if (HELP.test(body)) res.end(HELP_TEXT)
				else if (teamMatch = TEAM_NUMBER.exec(body)) requestMatches(teamMatch[1], from, res)
				else res.end('Please enter a team number. ' + HELP_TEXT)
			}
			catch (e) { errorRespond(res)(e) }
		})
}

//Load certs and start HTTPS server
Promise.all([
	readFile('../server/key.pem'),
	readFile('../server/cert.pem'),
	readFile('../server/chain.pem')
])
	.then(([key, cert, ca]) => {
		https.createServer({key, cert, ca}, httpRespond)
			.listen(PORT)
		console.log('Server started')
	})
	.catch(err => {
		console.error('Could not start server')
		console.error(err)
		process.exit(1)
	})

//Check for new matches periodically
setInterval(() =>
	fetchMatches().catch(console.error),
	MATCH_CHECK_INTERVAL
)