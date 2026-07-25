/**
 * Player roster extraction.
 *
 * The demoparser2 WASM build has no `parsePlayerInfo` (unlike the Node/Python
 * builds), so the roster is sampled from `parseTicks(["name","team_num",
 * "steamid"])` at the first few rounds' freeze ticks — where all players are
 * spawned. `initial_team` here is provisional; parseDemo overrides it with the
 * position-derived value (which is pre-halftime and canonical).
 */

import type { DemoSource, Row } from './source';
import type { ParsedPlayer, ParsedRound } from './types';
import { toInt, toSteamIdStr } from './utils';

export function extractPlayers(source: DemoSource, rounds: ParsedRound[]): ParsedPlayer[] {
  const sampleTicks = rounds.length
    ? [...new Set(rounds.slice(0, 4).map((r) => Math.max(r.freeze_end_tick, r.start_tick)))]
    : [1];

  let rows: Row[] = [];
  try {
    rows = source.parseTicks(['name', 'team_num', 'steamid'], sampleTicks);
  } catch {
    return [];
  }

  const seen = new Set<number>();
  const players: ParsedPlayer[] = [];
  for (const row of rows) {
    const idNum = toInt(row.steamid ?? 0, 0);
    if (idNum === 0 || seen.has(idNum)) continue;
    seen.add(idNum);
    const teamNum = toInt(row.team_num ?? 0);
    const team = teamNum === 2 ? 'T' : teamNum === 3 ? 'CT' : '';
    players.push({
      player_id: idNum,
      player_id_str: toSteamIdStr(row.steamid),
      name: String(row.name ?? ''),
      initial_team: team,
    });
  }
  return players;
}
