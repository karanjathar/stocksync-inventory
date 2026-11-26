import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Assistant } from './Assistant';
import { mockApi } from '../test/setup';

describe('Assistant', () => {
  it('sends the question with recent turns and shows the answer with the figures used', async () => {
    const calls = mockApi({
      '/assistant/status': { available: true },
      'POST /assistant/ask': { answer: 'Only T-Shirt is low.', figures: [{ tool: 'low_stock', input: {}, result: [{ sku: 'TEE', inStock: 3 }] }] },
    });
    render(<Assistant />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'what is low?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(/Only T-Shirt is low/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ question: 'what is low?', history: [] });
    expect(screen.getByText('Figures used (1)')).toBeInTheDocument();
    expect(screen.getByText(/"inStock": 3/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'and mugs?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findAllByText(/Only T-Shirt is low/);
    const second = calls.filter((c) => c.method === 'POST')[1]!.body as { history: { role: string }[] };
    expect(second.history.map((h) => h.role)).toEqual(['user', 'assistant']);
  });

  it('explains when the assistant is unavailable and does not let the user ask', async () => {
    mockApi({ '/assistant/status': { available: false } });
    render(<Assistant />);
    expect(await screen.findByText(/not available for your business/)).toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toBeDisabled();
  });

  it('shows the server\'s message when a question fails', async () => {
    mockApi({ '/assistant/status': { available: true }, 'POST /assistant/ask': new Response(JSON.stringify({ error: { code: 'AI_BUDGET', message: 'Your Pro plan\'s AI allowance for this month is used up.' } }), { status: 402 }) });
    render(<Assistant />);
    fireEvent.click(await screen.findByRole('button', { name: 'What is running low?' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('allowance for this month is used up');
  });
});
