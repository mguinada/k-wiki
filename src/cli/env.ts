/**
 * Shared CLI environment-variable names: the cross-domain contracts
 * a launcher sets and a spawn site consumes, in one place so neither
 * side hardcodes the other's string.
 */

/** The environment variable a launcher sets to hand the agent spawn
 *  an absolute binary path (issue #399): launchd's minimal PATH
 *  cannot resolve a bare agent command installed outside the
 *  standard dirs, so the scheduled-run launcher resolves it once —
 *  scheduled PATH, then the login shell — and every spawned child
 *  inherits the absolute path; the agent spawn sites prefer it over
 *  the settings' bare command name. */
export const AGENT_COMMAND_ENV = "KWIKI_AGENT_COMMAND";
