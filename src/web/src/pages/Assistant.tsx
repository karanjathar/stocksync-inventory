import { useRef, useState, type FormEvent } from 'react';
import { api, errorText } from '../api/client';
import { useApi } from '../hooks';
import { Card, ErrorBanner, Page } from '../components/ui';

interface Figure { tool: string; input: Record<string, unknown>; result: unknown }
interface Turn { role: 'user' | 'assistant'; content: string; figures?: Figure[] }

const EXAMPLES = ['What is running low?', 'How were sales in the last 7 days?', 'What should I reorder?', 'Which products sell best this month?'];

/** Ask questions about stock, sales and orders. Read-only: it cannot change anything, and each answer lists the figures it was built from. */
export function Assistant() {
  const status = useApi<{ available: boolean }>('/assistant/status');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true); setError(null); setQuestion('');
    const history = turns.slice(-6).map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: 'user', content: q }]);
    try {
      const res = await api<{ answer: string; figures: Figure[] }>('/assistant/ask', { body: { question: q, history } });
      setTurns((t) => [...t, { role: 'assistant', content: res.answer, figures: res.figures }]);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); setTimeout(() => end.current?.scrollIntoView?.({ block: 'end' }), 0); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void ask(question); };

  return (
    <Page title="Assistant">
      {status.data?.available === false && <p role="status" className="muted">The assistant is not available for your business right now (it is switched off, not part of your plan, or this month's allowance is used up).</p>}
      <Card>
        <div className="chat" aria-live="polite">
          {!turns.length && <div><p className="muted">Ask about your stock, sales or orders. I can only read your data; I cannot change anything.</p>
            <div className="row">{EXAMPLES.map((x) => <button key={x} type="button" className="small" disabled={busy || status.data?.available === false} onClick={() => void ask(x)}>{x}</button>)}</div></div>}
          {turns.map((t, i) => (
            <div key={i} className={`bubble ${t.role}`}>
              <p><strong>{t.role === 'user' ? 'You' : 'Assistant'}:</strong> {t.content}</p>
              {t.figures && t.figures.length > 0 && (
                <details><summary>Figures used ({t.figures.length})</summary>
                  {t.figures.map((f, j) => <div key={j}><div className="muted small">{f.tool}{Object.keys(f.input).length ? ` ${JSON.stringify(f.input)}` : ''}</div><pre className="small">{JSON.stringify(f.result, null, 1)}</pre></div>)}
                </details>
              )}
            </div>
          ))}
          {busy && <p className="muted" role="status">Thinking…</p>}
          <div ref={end} />
        </div>
        <ErrorBanner error={error} />
        <form onSubmit={submit} aria-label="Ask the assistant" className="row">
          <input aria-label="Your question" value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. what is running low?" disabled={status.data?.available === false} />
          <button className="primary" type="submit" disabled={busy || !question.trim() || status.data?.available === false}>Ask</button>
        </form>
      </Card>
    </Page>
  );
}
