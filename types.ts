export type Alliance = [string, string]
export interface TeamMatch {
	match: number
	color: 'red' | 'blue'
	partner: string
	opponents: Alliance
}
export interface MatchFile {
	division: string
	matches: TeamMatch[]
}

export interface URLs {
	[division: string]: string
}