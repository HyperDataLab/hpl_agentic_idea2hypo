import { describe, expect, it } from 'vitest';
import { EventGapError, MemoryLogStore, RunLog, sseFrame, statusAfter, toEnvelope } from './runLog';

const now = () => new Date('2026-11-19T00:00:00.000Z');
const ev = (seq: number, type = 'stage.started', payload: Record<string, unknown> = {}) => ({
  source_seq: seq,
  type,
  stage_key: 'scope',
  actor: null,
  payload,
});

function log() {
  const runLog = new RunLog(new MemoryLogStore(), now);
  runLog.init('run-1', 'proj-1', 'a@hyperdatalab.org');
  return runLog;
}

describe('RunLog', () => {
  it('keeps the engine sequence, drops repeats and refuses gaps', () => {
    const runLog = log();
    expect(runLog.ingest([ev(1), ev(2)]).map((e) => e.seq)).toEqual([1, 2]);
    expect(runLog.ingest([ev(1), ev(2), ev(3)]).map((e) => e.seq)).toEqual([3]);
    expect(() => runLog.ingest([ev(5)])).toThrow(EventGapError);
    expect(runLog.lastSeq()).toBe(3);
    expect(runLog.read(1, 10).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('builds the envelope the app reads', () => {
    expect(toEnvelope('run-1', ev(4, 'card.extracted', { id: 'c1' }), '2026-11-19T00:00:00.000Z')).toEqual({
      seq: 4,
      run_id: 'run-1',
      ts: '2026-11-19T00:00:00.000Z',
      type: 'card.extracted',
      stage_key: 'scope',
      payload: { id: 'c1' },
    });
  });

  it('follows the run status from run.status and run.completed', () => {
    const runLog = log();
    runLog.ingest([ev(1, 'run.started')]);
    expect(runLog.meta()?.status).toBe('running');
    runLog.ingest([ev(2, 'run.status', { status: 'awaiting_review' })]);
    expect(runLog.meta()?.status).toBe('awaiting_review');
    runLog.ingest([ev(3, 'run.status', { status: 'paused', reason: 'interrupted' })]);
    expect(runLog.meta()).toMatchObject({ status: 'paused', message: 'interrupted' });
    runLog.ingest([ev(4, 'run.completed')]);
    expect(runLog.meta()).toMatchObject({ status: 'completed', message: null });
    expect(statusAfter({ status: 'running', message: null }, [toEnvelope('r', ev(5, 'run.status', { status: 'bogus' }), 'x')]).status).toBe('running');
  });

  it('refuses malformed events', () => {
    expect(() => log().ingest([{ source_seq: 1, type: 'x' }])).toThrow(TypeError);
  });

  it('writes SSE frames with the seq as id', () => {
    const frame = sseFrame(toEnvelope('run-1', ev(7), 't'));
    expect(frame.startsWith('id: 7\nevent: run-event\ndata: {')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
