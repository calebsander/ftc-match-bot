export type Alliance = [string, string]
export interface TeamMatch {
	match: number
	color: 'red' | 'blue'
	partner: string
	opponents: Alliance
}