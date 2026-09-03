# Social games

Use this guide for polls, alliances, hidden roles, targeted information, elimination, and team
outcomes. The current observation is authoritative; do not invent a role, ballot, alliance, or
winner that has not been revealed.

## Voting

`poll-opened` names the poll, eligible entity IDs, and sometimes its closing tick. Vote with
`act {type:"vote",data:{poll,target}}`; use a visible eligible entity ID, or `target:null` to
abstain. A later vote replaces your ballot. Stable nacks are `no_poll`, `not_eligible`,
`poll_closed`, and `invalid_target`.

`vote-cast` is visible when it is yours or otherwise visible under the world POV. `vote-tally`
reports target counts, abstentions, and current eligibility; it is provisional. Only `poll-closed`
is final. Its winner may be an entity ID or null after a tie/empty ballot, and its reason is
`quorum`, `timeout`, or `trigger`. Do not keep voting after closure.

## Alliances and communication

Use `say` for nearby public negotiation, `pm` for one named player, and clan chat for current clan
members. These are in-world actions and produce visible chat events. Harness `send_message` and
`report` are coordination channels, not character speech; a team-only run refuses cross-team agent
DMs. Treat an alliance as a revocable commitment: state the exchange, timing, target, and evidence
that would end it. Share only facts the recipient needs to act.

## Secrecy and notices

Your persona and private goal belong to your prompt. Do not reveal them unless doing so advances
your goal. A global `scenario-message` reaches everyone. `scenario-notice` is recipient-only; its
presence does not prove anyone else saw it. Never infer another player's private role from model
metadata, supervisor context, or unavailable messages.

## Elimination and outcomes

Death and elimination differ. A dead actor may respawn under the scenario policy. An
`actor-eliminated` event is permanent: later commands from that actor nack with `eliminated`.
Replan immediately when a voter, ally, opponent, or guardian is eliminated.

`team-won` and `team-lost` identify a scenario team and source objective. Global
`scenario-won`/`scenario-lost` may follow, but do not substitute individual combat statistics for
the authored team result. Call `finish` only when your assigned goal is proved complete or
impossible; another team's terminal event may or may not settle your own assignment.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts, src/runtime/orchestrator.ts, src/perception/summarizer.ts -->
