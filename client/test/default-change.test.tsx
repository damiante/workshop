import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentClassView } from '../../server/src/api-types.ts';
import { DefaultChange } from '../src/components/DefaultChange.tsx';

const agent: AgentClassView = {
  name: 'implement',
  label: 'Implementation',
  description: '',
  model: null,
  modelConnectionId: null,
  effort: null,
  billing: 'subscription',
  prompt: 'Mine.',
  defaultPrompt: 'Keep it focused.\nCommit for the Code reviewer.',
  customised: true,
  defaultBefore: null,
  defaultUnknown: false,
  protocol: '',
  maxTurns: 100,
  timeoutMin: 60,
};
const render = (a: Partial<AgentClassView>) => renderToStaticMarkup(<DefaultChange agent={{ ...agent, ...a }} onDismiss={() => {}} onReset={() => {}} />);

describe('DefaultChange', () => {
  it("shows what changed in an out-of-date agent's default", () => {
    const html = render({ defaultBefore: 'Keep it focused.\nReview your own diff.' });
    expect(html).toContain('default instructions for this agent have changed since you customised them');
    expect(html).toContain('What changed in the default');
    expect(html).toContain('<div class="same">  Keep it focused.</div>');
    expect(html).toContain('<div class="removed">- Review your own diff.</div>');
    expect(html).toContain('<div class="added">+ Commit for the Code reviewer.</div>');
    expect(html).toContain('>Dismiss</button>');
    expect(html).toContain('>Reset to default</button>');
  });

  it("notes when Workshop can't tell", () => {
    const html = render({ defaultUnknown: true });
    expect(html).toContain("can&#x27;t tell whether the default has changed");
    expect(html).toContain('>Dismiss</button>');
    expect(html).not.toContain('Reset to default');
  });

  it('renders nothing for an up-to-date agent', () => {
    expect(render({})).toBe('');
  });
});
