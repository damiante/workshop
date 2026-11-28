import type { AgentClassView } from '../../../server/src/api-types.ts';
import { lineDiff } from '../diff.ts';

const PREFIX = { same: '  ', added: '+ ', removed: '- ' };

/** Tells the owner when Workshop's default instructions moved on since they customised an agent's. */
export function DefaultChange({ agent, onDismiss, onReset }: { agent: AgentClassView; onDismiss: () => void; onReset: () => void }) {
  if (agent.defaultBefore !== null) {
    return (
      <div className="notice stack">
        <span>Workshop's default instructions for this agent have changed since you customised them. Carry over what you want, then save.</span>
        <details open>
          <summary className="small">What changed in the default</summary>
          <pre className="mono small diff">
            {lineDiff(agent.defaultBefore, agent.defaultPrompt).map((line, i) => (
              <div key={i} className={line.kind}>
                {PREFIX[line.kind] + line.text}
              </div>
            ))}
          </pre>
        </details>
        <div className="row">
          <button type="button" className="link small" onClick={onDismiss}>
            Dismiss
          </button>
          <button type="button" className="link small" onClick={onReset}>
            Reset to default
          </button>
        </div>
      </div>
    );
  }
  if (agent.defaultUnknown) {
    return (
      <div className="notice row">
        <span className="small">You customised these instructions before Workshop kept track of its defaults, so it can't tell whether the default has changed since.</span>
        <button type="button" className="link small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}
