import * as fs from 'fs'
import {promisify} from 'util'
const writeFile = promisify(fs.writeFile)
import * as htmlSoup from 'html-soup'
import {HtmlTag, TextNode} from 'html-soup/dist/parse'
import fetch from 'node-fetch'
import {Alliance, MatchFile, TeamMatch, URLs} from './types'

const MATCHES_DIR = 'matches'
const MATCH_LIST_URLS: URLs = {
	Allegheny: 'http://scoring.ftcpenn.org/cache/Matches_championship_1.html',
	Pocono: 'http://scoring.ftcpenn.org/cache/Matches_championship_2.html'
}

interface Match {
	number: string
	redTeams: Alliance
	blueTeams: Alliance
}
interface TeamMatches {
	[team: string]: TeamMatch[]
}

(async () => {
	const [divisionMatches] = await Promise.all([
		Promise.all(Object.keys(MATCH_LIST_URLS).map(async division => {
			const res = await fetch(MATCH_LIST_URLS[division])
			const body = await res.text()
			const dom = htmlSoup.parse(body)
			const rows = htmlSoup.select(dom, 'tr')
			const matches: Match[] = []
			for (const row of rows) {
				if (htmlSoup.select(row, 'th').size) continue //ignore header row

				const children = row.children as HtmlTag[]
				const getTeam = (i: number) =>
					(children.slice(i)[0].child as TextNode).text
						.replace('*', '') //remove * from team number for surrogate matches
				matches.push({
					number: (children[0].child as TextNode).text,
					//Some matches lists have columns Number, Field, Red 1, Red 2, Blue 1, Blue 2
					//while others have no Field column, so we count columns from the right instead of the left
					redTeams: [-4, -3].map(getTeam) as Alliance,
					blueTeams: [-2, -1].map(getTeam) as Alliance
				})
			}
			return {division, matches}
		})),
		promisify(fs.mkdir)(MATCHES_DIR)
			.catch(_ => {}) //not a problem if it already exists
	])
	const teamsDivisions: {[team: string]: string} = {}
	const teamsMatches: TeamMatches = {}
	for (const {division, matches} of divisionMatches) {
		for (const {number, redTeams, blueTeams} of matches) {
			for (const team of redTeams.concat(blueTeams)) {
				teamsDivisions[team] = division
				const onRed = redTeams.includes(team)
				let teamMatches = teamsMatches[team]
				if (!teamMatches) teamsMatches[team] = teamMatches = []
				teamMatches.push({
					match: Number(number),
					color: onRed ? 'red' : 'blue',
					partner: (onRed ? redTeams : blueTeams).find(team2 => team2 !== team)!,
					opponents: onRed ? blueTeams : redTeams
				})
			}
		}
	}
	const matchCountTeams = new Map<number, string[]>()
	const writePromises: Promise<void>[] = []
	for (const team in teamsMatches) {
		const matches = teamsMatches[team]
		const matchCount = matches.length
		let teamsWithMatchCount = matchCountTeams.get(matchCount)
		if (!teamsWithMatchCount) {
			matchCountTeams.set(matchCount, teamsWithMatchCount = [])
		}
		teamsWithMatchCount.push(team)
		const teamData: MatchFile = {division: teamsDivisions[team], matches}
		writePromises.push(writeFile(
			`${MATCHES_DIR}/${team}.json`,
			JSON.stringify(teamData)
		))
	}
	if (matchCountTeams.size > 1) {
		console.error('Unequal match counts:', matchCountTeams)
	}
	await Promise.all(writePromises)
})()