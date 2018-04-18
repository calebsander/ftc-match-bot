import * as fs from 'fs'
import {promisify} from 'util'
import * as htmlSoup from 'html-soup'
import {HtmlTag, TextNode} from 'html-soup/dist/parse'
import fetch from 'node-fetch'
import {Alliance, TeamMatch} from './types'

const MATCHES_DIR = 'matches'
const MATCH_LIST_URLS = [
	'http://detroit.worlds.pennfirst.org/cache/Matches_2018_World_Championship_Edison.html',
	'http://detroit.worlds.pennfirst.org/cache/Matches_2018_World_Championship_Ochoa.html'
]

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
	Promise.all(MATCH_LIST_URLS.map(url =>
		fetch(url)
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
				return matches
			})
	))
])
	.then(([_, divisionMatches]) => {
		const teamsMatches: TeamMatches = {}
		for (const matches of divisionMatches) {
			for (const {number, redTeams, blueTeams} of matches) {
				for (const team of redTeams.concat(blueTeams)) {
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
		const writePromises: Promise<void>[] = []
		for (const team in teamsMatches) {
			const teamMatches = teamsMatches[team]
			if (matchCount === undefined) matchCount = teamMatches.length
			else if (teamMatches.length !== matchCount) throw new Error('Unequal match counts')
			writePromises.push(promisify(fs.writeFile)(
				MATCHES_DIR + '/' + team + '.json',
				JSON.stringify({matches: teamMatches})
			))
		}
		return Promise.all(writePromises)
	})