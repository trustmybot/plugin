/**
 * UserPromptSubmit hook (GH 1692), the port of scripts/hooks/user-prompt-persona.sh:
 * the persona fallback for a session SessionStart did not cover (a resumed or
 * cleared session). It injects the persona once per session, or, when the
 * plugin's CLAUDE.md cannot be read, a one-time systemMessage. Never blocks.
 */
import { existsSync } from 'node:fs';
import { ALLOW, type GateResult } from './gate.js';
import { personaContext, personaEmit, personaInit, personaMark, personaMarker, personaSessionId, commandOnPath } from './lib/persona.js';
import { commandSubstitution } from './lib/project-env.js';

export const GATE_NAME = 'user-prompt-persona';

export const PERSONA_UNREADABLE_NOTICE =
  `{"systemMessage":"TMB could not read the plugin CLAUDE.md that carries bro's persona, so this session runs without it. Start a new Claude Code session to load it."}\n`;

export function userPromptPersona(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    const haveJq = commandOnPath('jq', env);
    const sessionId = personaSessionId(commandSubstitution(payload), haveJq);
    if (sessionId === '') return ALLOW;
    const persona = personaInit(env, haveJq);
    if (persona === null) return ALLOW;
    if (existsSync(personaMarker(persona, sessionId, 'persona'))) return ALLOW;
    const context = personaContext(persona, env);
    if (context !== null) {
      const stdout = personaEmit(persona, 'UserPromptSubmit', context);
      personaMark(persona, sessionId, 'persona');
      return { stdout, code: 0 };
    }
    if (existsSync(personaMarker(persona, sessionId, 'persona-notice'))) return ALLOW;
    personaMark(persona, sessionId, 'persona-notice');
    return { stdout: PERSONA_UNREADABLE_NOTICE, code: 0 };
  } catch {
    return ALLOW;
  }
}
