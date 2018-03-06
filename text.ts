import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as querystring from 'querystring'
import {promisify} from 'util'
import * as htmlSoup from 'html-soup'
import {TextNode, HtmlTag} from 'html-soup/dist/parse'
import fetch from 'node-fetch'
import * as twilio from 'twilio'
import {Alliance, TeamMatch} from './types'

const PORT = 6055
const TEAM_NUMBER = /(\d{1,5})/
const MATCH_RESULTS_URLS = [
	'http://scoring.ftceast.org/cache/MatchResults_East_Super-Regional_Hopper.html',
	'http://scoring.ftceast.org/cache/MatchResults_East_Super-Regional_Tesla.html'
]
const RANKING_URLS: {[division: string]: string} = {
	Hopper: 'https://calebsander.com/uploads/1483107180/ranking_hopper_test.html', //'http://scoring.ftceast.org/cache/Rankings_East_Super-Regional_Hopper.html',
	//Tesla: 'http://scoring.ftceast.org/cache/Rankings_East_Super-Regional_Tesla.html'
}
const REGISTERED_NUMBERS = './registered-numbers.json'
const ACCOUNT_FILE = './twilio-account.json'
const MATCH_SCORES = './recorded-matches.json'
const MATCHES_DIR = './matches/'
const NUMBER = '+13236886055'
const STOP = 'done'
const STOP_MATCH = new RegExp(STOP, 'i')
const HELP = /\?/i
const END = ' -The GearTicks'
const RANK = 'rank'
const RANKING = new RegExp(RANK, 'i')
const RANK_TEXT = ' Text "' + RANK + '" for rankings.'
const HELP_TEXT = 'Text "' + STOP + '" to disable.' + RANK_TEXT + END
const TIE_CHARACTER = '☯', LOSS_CHARACTER = '☠', WIN_CHARACTER = '⛄'

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
	won: string
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

function deregister(from: string): void {
	for (const team in registeredNumbers) {
		const numbers = registeredNumbers[team]
		const index = team.indexOf(from)
		if (index > -1) {
			numbers.splice(index, 1)
			break
		}
	}
}
function saveRegistered(): Promise<void> {
	return promisify(fs.writeFile)(REGISTERED_NUMBERS, JSON.stringify(registeredNumbers))
}
function errorRespond(res: http.ServerResponse): (err: Error) => void {
	return (err: Error) => {
		console.error(err)
		res.end('Error occurred')
	}
}
function sendMessage(number: string, message: string) {
	twilioInstance.messages.create({
		to: number,
		from: NUMBER,
		body: message
	})
		.then(() => console.log('Sent message to ' + number + ': "' + message + '"'))
		.catch(console.error)
}
function reportNewMatch(matchData: MatchData) {
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
		for (const number of registeredNumbers[team] || []) sendMessage(number, response!)
	}
}
function recordMatch(id: string, matchData: MatchData): void {
	if (!(id in recordedMatches)) {
		recordedMatches[id] = matchData
		reportNewMatch(matchData)
	}
}
function fetchMatches(): Promise<void> {
	return Promise.all(MATCH_RESULTS_URLS.map((url, urlIndex) =>
		fetch(url)
			.then(res => res.text())
			.then(body => {
				const dom = htmlSoup.parse(body)
				const rows = [...htmlSoup.select(dom, 'tr')]
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i]
					if (!((row.child as HtmlTag).type === 'td' && row.children.length === 4)) continue //skip header rows
					const scoreCell = (row.children[1] as HtmlTag).child
					if (!scoreCell) continue //check that this is correct
					const [score, won] = (scoreCell as TextNode).text.split(' ')
					const match = ((row.child as HtmlTag).child as TextNode).text
					const matchId = String(urlIndex) + ' ' + match
					const nextRow = rows[i + 1]
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
		.then(() => promisify(fs.writeFile)(MATCH_SCORES, JSON.stringify(recordedMatches)))
}
function getResultsForTeam(team: string): MatchData[] {
	return Object.keys(recordedMatches)
		.map(id => recordedMatches[id])
		.filter(({redTeams, blueTeams}) => redTeams.includes(team) || blueTeams.includes(team))
}
const TIE = 0, RED_WIN = 1, BLUE_WIN = 2
const xor = (a: boolean, b: boolean) => (a as any) ^ (b as any)
function matchResultCharacter(matchData: MatchData, team: string): typeof TIE_CHARACTER | typeof LOSS_CHARACTER | typeof WIN_CHARACTER {
	const result = getResult(matchData)
	if (result === TIE) return TIE_CHARACTER
	return xor(matchData.blueTeams.includes(team), result === BLUE_WIN)
		? LOSS_CHARACTER
		: WIN_CHARACTER
}
function getResult(match: MatchData): typeof TIE | typeof RED_WIN | typeof BLUE_WIN {
	const allianceScores = match.score.split('-')
	if (allianceScores[0] === allianceScores[1]) return TIE
	if (match.won === 'R') return RED_WIN
	else return BLUE_WIN
}
function requestMatches(team: string, from: string, res: http.ServerResponse) {
	promisify(fs.readFile)(MATCHES_DIR + team + '.json', 'utf8')
		.then(matchData => {
			const matches = JSON.parse(matchData).matches as TeamMatch[]
			return fetchMatches()
				.then(() => {
					let response = ''
					const matchResults = getResultsForTeam(team)
					for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
						const {match, color, partner, opponents} = matches[matchIndex]
						if (response) response += '\n'
						response += String(match) + (color === 'blue' ? '🔵' : '🔴')
						response += ' w/ ' + partner
						response += ' v. ' + opponents.join(' & ')
						if (matchIndex < matchResults.length) { //match result known
							const result = matchResults[matchIndex]
							response += ' (' + matchResultCharacter(result, team) + ' ' + result.score + ')'
						}
					}
					//Add post-qualification matches
					for (let matchIndex = matches.length; matchIndex < matchResults.length; matchIndex++) {
						const result = matchResults[matchIndex]
						response += '\n' + result.match
							+ ' (' + matchResultCharacter(result, team) + ' ' + result.score + ')'
					}
					//Must add numbers after fetching matches to avoid sending notifications for newly recorded matches
					deregister(from)
					if (!registeredNumbers[team]) registeredNumbers[team] = []
					registeredNumbers[team].push(from)
					response += '\nYou will now be texted when team ' + team + "'s scores are announced. " + HELP_TEXT
					return saveRegistered()
						.then(() => {
							res.end(response)
							console.log('Responded')
						})
				})
				.catch(errorRespond(res))
		})
		.catch(() => res.end('Team ' + team + ' does not exist'))
}
function getTeam(textNumber: string) {
	for (const team in registeredNumbers) {
		if (registeredNumbers[team].includes(textNumber)) return team
	}
	throw new Error('Not signed up for a team')
}
function requestRanking(teamNumber: string, res: http.ServerResponse) {
	let response = '(QP, RP, Matches)'
	Promise.all(Object.keys(RANKING_URLS).map(division =>
		fetch(RANKING_URLS[division])
			.then(res => res.text())
			.then(body => {
				const dom = htmlSoup.parse(body)
				const rows = htmlSoup.select(dom, 'tr')
				response += '\n' + division
				for (const row of rows) {
					if (htmlSoup.select(row, 'th').size) continue
					const [rank, team, QP, RP, matches] = [0, 1, 3, 4, 6].map(col =>
						((row.children[col] as HtmlTag).child as TextNode).text
					)
					if (Number(rank) > 10 && team !== teamNumber) continue
					response += '\n' + rank + '. ' + team
						+ ' (' + QP + ', ' + RP + ', ' + matches + ')'
				}
			})
	))
		.then(() => {
			res.end(response + END)
			console.log('Responded with rank')
		})
		.catch(errorRespond(res))
}

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
const readFile = promisify(fs.readFile)

const getCert = Promise.all([
	readFile('../server/key.pem'),
	readFile('../server/cert.pem'),
	readFile('../server/chain.pem')
])
	.then(([key, cert, ca]) => {
		https.createServer({key, cert, ca}, httpRespond)
			.listen(PORT)
	})
	.catch(err => {
		console.error('Could not start server')
		console.error(err)
	})

setInterval(() =>
	fetchMatches()
		.catch(err => console.error(err)),
	30000
)