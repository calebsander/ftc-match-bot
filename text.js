const fs = require('fs');
const http = require('http');
const querystring = require('querystring');
const select = require('soupselect').select,
	htmlParser = require('htmlparser');

const MATCHES = 'MATCHES';
const TEAM_NUMBER = /(\d{1,5})/;
const MATCH_LIST_URLS = ['http://scoring.pennfirst.org/cache/Match_Results_2016_World_Championship_Edison.html', 'http://scoring.pennfirst.org/cache/Match_Results_2016_World_Championship_Franklin.html'];
const REGISTERED_NUMBERS = __dirname + '/registeredNumbers.json';
const ACCOUNT_FILE = __dirname + '/twilio-account.json';
const MATCH_SCORES = __dirname + '/recordedMatches.json';
const NUMBER = '+15079356055';
const STOP = 'done';
const STOP_MATCH = /done/i;
const HELP = /\?/i;
const END = ' -The GearTicks';
const RANKING = /rank/i;
const RANK_TEXT = "Text 'rank' for rankings.";
const HELP_TEXT = "Text '" + STOP + "' to disable. " + RANK_TEXT + END;

var registeredNumbers = {};
fs.readFile(REGISTERED_NUMBERS, (err, data) => {
	if (!err) registeredNumbers = JSON.parse(data);
});
var twilio;
fs.readFile(ACCOUNT_FILE, (err, data) => {
	if (err) throw err;
	else {
		data = JSON.parse(data);
		twilio = require('twilio')(data.sid, data.authToken);
	}
});
module.exports = function(DIRNAME) {
	const MATCHES_DIR = DIRNAME + '/files/matches/';
	return function(req, res) {
		try {
			var data = '';
			req.on('data', (chunk) => {
				if (data.length + chunk.length > 1e7) req.destroy();
				else data += chunk;
			});
			req.on('end', () => {
				data = querystring.parse(data);
				data.NumMedia = Number(data.NumMedia);
				console.log(data);
				res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
				if (data.NumMedia) res.end('This is an SMS-only service');
				else {
					console.log('SMS: ' + data.Body);
					if (RANKING.exec(data.Body)) {
						requestRanking(getTeam(data.From), res);
						return;
					}
					if (STOP_MATCH.exec(data.Body)) {
						deregister(data.From);
						fs.writeFile(REGISTERED_NUMBERS, JSON.stringify(registeredNumbers), (err) => {
							if (err) throw err;
							else res.end('Unsubscribed');
						});
						console.log('Unsubscribed ' + data.From);
						return;
					}
					if (HELP.exec(data.Body)) {
						res.end(HELP_TEXT);
						return;
					}
					const teamMatch = TEAM_NUMBER.exec(data.Body);
					if (teamMatch) {
						const team = teamMatch[1];
						fs.readFile(MATCHES_DIR + team + '.json', (err, matchData) => {
							if (err) res.end('Team ' + team + ' does not exist');
							else {
								var response = '';
								const matches = JSON.parse(matchData).matches;
								fetchMatches(() => {
									var matchResults = getResultsForTeam(team);
									for (var match in matches) {
										var matchIndex = Number(match);
										match = matches[match];
										if (response.length) response += '\n';
										response += match.match;
										if (match.color === 'blue') response += '🔵';
										else response += '🔴';
										response += ' w/ ';
										response += match.partner;
										response += ' v.';
										for (var opponent in match.opponents) {
											if (opponent !== '0') response += ' &';
											response += ' ' + match.opponents[opponent];
										}
										if (matchIndex in matchResults) {
											var result = matchResults[matchIndex];
											response += ' (';
											response += matchResultCharacter(result, team);
											response += ' ';
											response += result.score;
											response += ')';
										}
									}
									for (var match = matches.length; match < matchResults.length; match++) {
										var result = matchResults[match];
										response += '\n';
										response += result.match;
										response += ' (';
										response += matchResultCharacter(result, team);
										response += ' ';
										response += result.score;
										response += ')';
									}
									deregister(data.From);
									if (registeredNumbers[team]) registeredNumbers[team].push(data.From);
									else registeredNumbers[team] = [data.From];
									fs.writeFile(REGISTERED_NUMBERS, JSON.stringify(registeredNumbers), (err) => {
										if (err) throw err;
										else {
											response += '\nYou will now be texted when team ' + team + "'s scores are announced. " + HELP_TEXT;
											res.end(response);
											console.log('Responded');
										}
									});
								});
							}
						});
					}
					else res.end('Please enter a team number. ' + HELP_TEXT);
				}
			});
		}
		catch (err) {
			console.log(err);
			res.end('Error occured');
		}
	};
};

var recordedMatches = {};
fs.readFile(MATCH_SCORES, (err, data) => {
	if (!err) recordedMatches = JSON.parse(data);
});
function fetchMatches(callback) {
	var receivedMatchLists = 0;
	for (var url in MATCH_LIST_URLS) {
		http.get(MATCH_LIST_URLS[url], ((url) => {
			return (divisionRes) => {
				var body = '';
				divisionRes.on('data', (chunk) => body += chunk);
				divisionRes.on('end', () => {
					const handler = new htmlParser.DefaultHandler((err, dom) => {
						if (err) console.log(err);
						else {
							var rows = select(dom, 'tr');
							for (var i = 0; i < rows.length; i++) {
								row = rows[i];
								if (row.children[0].name === 'td' && row.children.length == 4) { //skip header rows
									var scoreCell = row.children[1].children[0].data;
									var score = scoreCell.split(' ');
									if (score != '&nbsp;') { //if no results yet, don't record the match
										var matchName = row.children[0].children[0].data;
										var matchId = url + matchName;
										recordMatch(matchId, {
											'match': matchName,
											'score': score[0],
											'won': score[1],
											'redTeams': [row.children[2].children[0].data, rows[i + 1].children[0].children[0].data],
											'blueTeams': [row.children[3].children[0].data, rows[i + 1].children[1].children[0].data]
										});
									}
								}
							}
						}
						receivedMatchLists++;
						if (receivedMatchLists === MATCH_LIST_URLS.length) {
							fs.writeFile(MATCH_SCORES, JSON.stringify(recordedMatches), (err) => {
								if (err) throw err;
							});
							if (callback) callback();
						}
					});
					const parser = new htmlParser.Parser(handler);
					parser.parseComplete(lowerCaseTags(body, ['tr', 'td', 'th']));
				});
			};
		})(url));
	}
	if (callback && !MATCH_LIST_URLS.length) callback(); //no match lists to use
}
function recordMatch(id, matchData) {
	if (!(id in recordedMatches)) {
		recordedMatches[id] = matchData;
		processNewMatch(matchData);
	}
}
function processNewMatch(matchData) {
	var onRedTeam, onBlueTeam, resultCharacter, response, number;
	for (var team in registeredNumbers) {
		onRedTeam = matchData.redTeams.indexOf(team) !== -1;
		onBlueTeam = matchData.blueTeams.indexOf(team) !== -1;
		if (onRedTeam || onBlueTeam) {
			resultCharacter = matchResultCharacter(matchData, team);
			switch (resultCharacter) {
				case TIE_CHARACTER:
					response = 'TIED';
					break;
				case LOSS_CHARACTER:
					response = 'LOST';
					break;
				case WIN_CHARACTER:
					response = 'WON';
			}
			response += ' match ';
			response += matchData.match;
			response += ' (';
			response += matchData.score;
			response += '). ' + RANK_TEXT + END;
			for (number in registeredNumbers[team]) sendMessage(registeredNumbers[team][number], response);
		}
	}
}
function getResultsForTeam(team) {
	const results = [];
	for (var match in recordedMatches) {
		match = recordedMatches[match];
		if (!(match.redTeams.indexOf(team) === -1 && match.blueTeams.indexOf(team) === -1)) results.push(match);
	}
	return results;
}
const TIE = 0, RED_WIN = 1, BLUE_WIN = 2;
const TIE_CHARACTER = '☯', LOSS_CHARACTER = '☠', WIN_CHARACTER = '⛄';
function matchResultCharacter(matchData, team) {
	const result = getResult(matchData);
	if (result === TIE) return TIE_CHARACTER;
	else {
		if (matchData.redTeams.indexOf(team) === -1 ^ result === BLUE_WIN) return LOSS_CHARACTER;
		else return WIN_CHARACTER;
	}
}
function getResult(match) {
	const allianceScores = match.score.split('-');
	if (allianceScores[0] === allianceScores[1]) return TIE;
	else {
		if (match.won === 'R') return RED_WIN;
		else return BLUE_WIN;
	}
}
function lowerCaseTags(text, tags) {
	for (var tag in tags) {
		tag = tags[tag];
		text = text.replace(new RegExp('<' + tag.toUpperCase() + ' ', 'g'), '<' + tag + ' ');
		text = text.replace(new RegExp('</' + tag.toUpperCase() + '>', 'g'), '</' + tag + '>');
	}
	return text;
}
function getTeam(textNumber) {
	for (var team in registeredNumbers) {
		if (registeredNumbers[team].indexOf(textNumber) !== -1) return team;
	}
}
const RANKING_URLS = ['http://scoring.pennfirst.org/cache/Rankings_2016_World_Championship_Edison.html', 'http://scoring.pennfirst.org/cache/Rankings_2016_World_Championship_Franklin.html'];
const DIVISION_START_INDEX = 'http://scoring.pennfirst.org/cache/Rankings_2016_World_Championship_'.length;
const DIVISION_END_INDEX = -'.html'.length;
function requestRanking(teamNumber, res) {
	var receivedRankings = 0;
	var result = '(QP, RP, Matches)';
	for (var url in RANKING_URLS) {
		http.get(RANKING_URLS[url], ((url) => {
			return (rankingRes) => {
				var body = '';
				rankingRes.on('data', (chunk) => body += chunk);
				rankingRes.on('end', () => {
					const handler = new htmlParser.DefaultHandler((err, dom) => {
						if (err) console.log(err);
						else {
							var rows = select(dom, 'tr');
							var team, td;
							var divisionResult = '\n' + url.substring(DIVISION_START_INDEX, url.length + DIVISION_END_INDEX);
							for (var i in rows) {
								row = rows[i];
								i = Number(i);
								td = row.children
								team = td[1].children[0].data;
								if (1 <= i && i <= 10 || team === teamNumber) {
									divisionResult += '\n' + td[0].children[0].data + '. ' + team + ' (' + td[3].children[0].data + ', ' + td[4].children[0].data + ', ' + td[6].children[0].data + ')';
								}
							}
						}
						result += divisionResult;
						receivedRankings++;
						if (receivedRankings === RANKING_URLS.length) {
							res.end(result + END);
							console.log('Responded with rank');
						}
					});
					const parser = new htmlParser.Parser(handler);
					parser.parseComplete(lowerCaseTags(body, ['tr', 'td', 'th']));
				});
			};
		})(RANKING_URLS[url]));
	}
}
function deregister(number) {
	for (var team in registeredNumbers) {
		team = registeredNumbers[team];
		var index = team.indexOf(number);
		if (index !== -1) {
			team.splice(index, 1);
			return;
		}
	}
}
function sendMessage(number, message) {
	twilio.messages.create({
		'to': number,
		'from': NUMBER,
		'body': message
	}, (err, message) => {
		if (err) throw err;
		else console.log('Sent message to ' + number + ': "' + message.body + '"');
	});
}