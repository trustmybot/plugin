/**
 * SessionStart hook (GH 1692), the port of scripts/hooks/session-start-persona.sh:
 * injects bro's persona, the plugin's CLAUDE.md, as additionalContext (raw
 * text when jq is not on PATH, as the .sh prints it) and marks the session so
 * user-prompt-persona does not inject it again. Never blocks: exit 0.
 */
import { ALLOW } from './gate.js';
import { personaContext, personaEmit, personaInit, personaMark, personaSessionId } from './lib/persona.js';
import { commandSubstitution } from './lib/project-env.js';
export const GATE_NAME = 'session-start-persona';
export function sessionStartPersona(payload, env) {
    try {
        const input = commandSubstitution(payload);
        const persona = personaInit(env);
        if (persona === null)
            return ALLOW;
        const context = personaContext(persona, env);
        if (context === null)
            return ALLOW;
        const stdout = personaEmit(persona, 'SessionStart', context);
        personaMark(persona, personaSessionId(input, persona.haveJq), 'persona');
        return { stdout, code: 0 };
    }
    catch {
        return ALLOW;
    }
}
//# sourceMappingURL=session-start-persona.js.map