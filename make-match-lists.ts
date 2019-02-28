import * as fs from 'fs'
import {promisify} from 'util'
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

Promise.all([
	promisify(fs.mkdir)(MATCHES_DIR)
		.catch(_ => {}), //not a problem if it already exists
	Promise.all(Object.keys(MATCH_LIST_URLS).map(division =>
		fetch(MATCH_LIST_URLS[division])
			.then(res => res.text())
			.then(body => {
				const dom = htmlSoup.parse(body)
				const rows = htmlSoup.select(dom, 'tr')
				const matches: Match[] = []
				for (const row of rows) {
					if (htmlSoup.select(row, 'th').size) continue //ignore header row
					const children = row.children as HtmlTag[]
					matches.push({
						number: (children[0].child as TextNode).text,
						//Some matches lists have columns Number, Field, Red 1, Red 2, Blue 1, Blue 2
						//while others have no Field column, so we count columns from the right instead of the left
						redTeams: [-4, -3].map(i => (children.slice(i)[0].child as TextNode).text) as [string, string],
						blueTeams: [-2, -1].map(i => (children.slice(i)[0].child as TextNode).text) as [string, string]
					})
				}
				return {division, matches}
			})
	))
])
	.then(([_, divisionMatches]) => {
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
		let matchCount: number | undefined
		return Promise.all(Object.keys(teamsMatches).map(team => {
			const teamMatches = teamsMatches[team]
			if (matchCount === undefined) matchCount = teamMatches.length
			else if (teamMatches.length !== matchCount) throw new Error('Unequal match counts')
			return promisify(fs.writeFile)(
				MATCHES_DIR + '/' + team + '.json',
				JSON.stringify({
					division: teamsDivisions[team],
					matches: teamMatches
				} as MatchFile)
			)
		}))
	})