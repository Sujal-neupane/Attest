import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FlagCard from './FlagCard.jsx';

/**
 * The flag card is where a person's judgement is recorded. These tests are
 * about the rules that make that record defensible, not about markup.
 */

const flag = (over = {}) => ({
  id: 'flag-1',
  type: 'invoice_gap',
  severity: 'medium',
  status: 'open',
  message: 'Sales invoice sequence "INV-" skips INV-004.',
  suggestion: 'Obtain the missing invoices, or written confirmation.',
  amountPaisa: -1130000,
  txnDate: '2024-07-17',
  party: 'Sharma Traders',
  invoiceNumber: 'INV-003',
  documentId: 'doc-1',
  documentFilename: 'sales.csv',
  sourceRef: { row: 5, raw: { date: '17/07/2024' } },
  aiDrafted: false,
  ...over,
});

const noop = () => {};

describe('FlagCard', () => {
  it('shows the finding, the figure and the way back to its source', () => {
    render(<FlagCard flag={flag()} onResolve={noop} onViewSource={noop} />);

    expect(screen.getByText(/skips INV-004/)).toBeInTheDocument();
    expect(screen.getByText('-Rs. 11,300.00')).toBeInTheDocument();
    // Provenance is the product's claim; it must be one click away, and it must
    // name the exact line.
    expect(screen.getByRole('button', { name: /View source.*sales\.csv.*line 5/ })).toBeInTheDocument();
  });

  it('states severity in text, not by colour alone', () => {
    render(<FlagCard flag={flag({ severity: 'high' })} onResolve={noop} onViewSource={noop} />);
    // WCAG 1.4.1: a reviewer with a colour-vision deficiency, or a printout,
    // must still be able to tell a high finding from a low one.
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('offers exactly three actions, every time', () => {
    render(<FlagCard flag={flag()} onResolve={noop} onViewSource={noop} />);
    // Hick's Law. A reviewer working a hundred findings makes the same
    // three-way decision a hundred times and should never re-read the options.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
  });

  it('accepts a finding and passes the note through', async () => {
    const onResolve = vi.fn().mockResolvedValue({});
    render(<FlagCard flag={flag()} onResolve={onResolve} onViewSource={noop} />);

    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await userEvent.type(screen.getByRole('textbox'), 'Confirmed with the client.');
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(onResolve).toHaveBeenCalledWith('flag-1', {
      status: 'accepted',
      note: 'Confirmed with the client.',
    });
  });

  it('REFUSES to dismiss a high-severity finding without a written reason', async () => {
    const onResolve = vi.fn();
    render(<FlagCard flag={flag({ severity: 'high' })} onResolve={onResolve} onViewSource={noop} />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // This is the rule that makes the review sheet a defensible record rather
    // than a list somebody clicked through. The database enforces it too; the
    // UI must not let someone reach that error by surprise.
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs a written reason/);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('rejects a token gesture as a reason', async () => {
    const onResolve = vi.fn();
    render(<FlagCard flag={flag({ severity: 'high' })} onResolve={onResolve} onViewSource={noop} />);

    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await userEvent.type(screen.getByRole('textbox'), 'ok');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onResolve).not.toHaveBeenCalled();
  });

  it('allows a high-severity dismissal once a real reason is given', async () => {
    const onResolve = vi.fn().mockResolvedValue({});
    render(<FlagCard flag={flag({ severity: 'high' })} onResolve={onResolve} onViewSource={noop} />);

    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await userEvent.type(
      screen.getByRole('textbox'),
      'Confirmed with client: INV-004 was cancelled and the copy retained.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onResolve).toHaveBeenCalledWith('flag-1', {
      status: 'dismissed',
      note: 'Confirmed with client: INV-004 was cancelled and the copy retained.',
    });
  });

  it('shows who decided and what they wrote, once resolved', () => {
    render(
      <FlagCard
        flag={flag({
          status: 'dismissed',
          resolvedByName: 'Sujal Neupane',
          resolvedAt: '2024-08-01T10:00:00.000Z',
          resolvedNote: 'Cancelled invoice, copy on file.',
        })}
        onResolve={noop}
        onViewSource={noop}
      />,
    );

    // Anonymous sign-off is worse than none, because it looks like
    // accountability. The name and the reason are both shown.
    expect(screen.getByText(/Dismissed/)).toBeInTheDocument();
    expect(screen.getByText(/Sujal Neupane/)).toBeInTheDocument();
    expect(screen.getByText(/Cancelled invoice, copy on file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('never lets a superseded flag read as though a person signed it off', () => {
    render(
      <FlagCard
        flag={flag({
          status: 'superseded',
          resolvedAt: '2024-08-01T10:00:00.000Z',
          resolvedNote: 'Superseded by a later reconciliation run.',
        })}
        onResolve={noop}
        onViewSource={noop}
      />,
    );

    expect(screen.getByText(/Superseded by a later run/)).toBeInTheDocument();
    expect(screen.queryByText(/Dismissed/)).not.toBeInTheDocument();
  });

  it('labels AI-drafted text as AI-drafted', () => {
    render(<FlagCard flag={flag({ aiDrafted: true })} onResolve={noop} onViewSource={noop} />);
    // A reviewer must always know whether a machine wrote the sentence they are
    // reading before they act on it.
    expect(screen.getByText('Drafted by AI')).toBeInTheDocument();
  });

  it('opens the source without also selecting the card', async () => {
    const onViewSource = vi.fn();
    const onSelect = vi.fn();
    render(
      <FlagCard flag={flag()} onResolve={noop} onViewSource={onViewSource} onSelect={onSelect} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /View source/ }));
    expect(onViewSource).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
