/**
 * SessionStart hook (GH 1692): injects bro's persona, the plugin's CLAUDE.md, as additionalContext (raw
 * text when jq is not on PATH) and marks the session so
 * user-prompt-persona does not inject it again, with the state this session
 * recorded before a compaction appended after it (session-handoff). Never
 * blocks: exit 0.
 */
import { ALLOW } from './gate.js';
import { personaContext, personaEmit, personaInit, personaMark, personaSessionId } from './lib/persona.js';
import { commandSubstitution } from './lib/project-env.js';
import { withHandoff } from './session-handoff.js';
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
        const stdout = personaEmit(persona, 'SessionStart', withHandoff(context, payload, env));
        personaMark(persona, personaSessionId(input, persona.haveJq), 'persona');
        return { stdout, code: 0 };
    }
    catch {
        return ALLOW;
    }
}
//# sourceMappingURL=session-start-persona.js.map