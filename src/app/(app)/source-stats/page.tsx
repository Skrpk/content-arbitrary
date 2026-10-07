'use client';

import Script from 'next/script';
import { useCallback, useRef, useState } from 'react';
import { TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * The source stats Mini App.
 *
 * Opened from the button under /sourcestats. Per source — grouped by
 * channel, each with its own totals — what it brought in over a period, how much of
 * it was approved, why the rest was turned down, and roughly what reading it
 * from X cost: the numbers to decide which accounts are worth keeping. Every
 * request carries Telegram's signed `initData`, as on the other pages.
 */

type Period = '7d' | '30d' | 'all';

interface SourceView {
  sourceId: number;
  username: string;
  enabled: boolean;
  posts: number;
  approved: number;
  rejected: number;
  waiting: number;
  notSent: number;
  approvalRate: number | null;
  rejectionReasons: { reason: string | null; count: number }[];
  readCostUsd: number;
  costPerApprovedUsd: number | null;
  lastPostAt: string | null;
}

interface ChannelView {
  id: number;
  name: string;
  sources: SourceView[];
}

interface StatsResponse {
  channels: ChannelView[];
  postReadUsd: number;
  reasonLabels: Record<string, string>;
}

type Phase = 'waiting-for-telegram' | 'loading' | 'ready' | 'error';

const PERIODS: { key: Period; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
];

const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
const dollars = (usd: number | null) => (usd === null ? '—' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`);

/** "3h ago", "2d ago": when a source last brought anything in. */
function ago(iso: string | null): string {
  if (!iso) return 'nothing yet';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Green when most is approved, red when almost nothing is. */
function rateColour(rate: number | null): string {
  if (rate === null) return theme.hint;
  if (rate >= 0.4) return '#2e9e4f';
  if (rate >= 0.15) return '#d08a00';
  return '#e53935';
}

function totalsOf(sources: SourceView[]) {
  const sum = (pick: (source: SourceView) => number) =>
    sources.reduce((total, source) => total + pick(source), 0);
  const approved = sum((source) => source.approved);
  const rejected = sum((source) => source.rejected);
  const readCostUsd = sum((source) => source.readCostUsd);
  return {
    posts: sum((source) => source.posts),
    approved,
    approvalRate: approved + rejected > 0 ? approved / (approved + rejected) : null,
    readCostUsd,
    costPerApprovedUsd: approved > 0 ? readCostUsd / approved : null,
  };
}

export default function SourceStatsPage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('7d');
  const [data, setData] = useState<StatsResponse | null>(null);
  /** Only the latest period's answer is shown, whatever order they arrive in. */
  const latest = useRef(0);

  const load = useCallback(async (next: Period) => {
    const app = window.Telegram?.WebApp;

    if (!app) {
      setPhase('error');
      setMessage('Telegram did not load. Open this from the button under /sourcestats.');
      return;
    }

    app.ready();
    app.expand();

    if (!app.initData) {
      setPhase('error');
      setMessage('This page only works when opened from the bot in Telegram.');
      return;
    }

    const request = ++latest.current;
    setPeriod(next);
    setPhase('loading');

    try {
      const response = await fetch(`/api/telegram/webapp/source-stats?period=${next}`, {
        headers: { Authorization: `tma ${app.initData}` },
      });
      const body = (await response.json()) as StatsResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
      if (request !== latest.current) return;

      setData(body);
      setPhase('ready');
    } catch (error: unknown) {
      if (request !== latest.current) return;
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not load the stats.');
    }
  }, []);

  const labelOf = (reason: string | null) =>
    reason === null ? 'No reason given' : (data?.reasonLabels[reason] ?? reason);

  return (
    <>
      <Script
        src={TELEGRAM_WEB_APP_SCRIPT}
        strategy="afterInteractive"
        onReady={() => {
          void load('7d');
        }}
      />

      <main
        style={{
          background: theme.bg,
          color: theme.text,
          minHeight: '100vh',
          padding: '1rem',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.75rem' }}>Source stats</h1>

        <div role="tablist" style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
          {PERIODS.map((option) => {
            const active = option.key === period;
            return (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={phase === 'waiting-for-telegram'}
                onClick={() => {
                  if (!active || phase === 'error') void load(option.key);
                }}
                style={{
                  flex: 1,
                  padding: '0.45rem 0',
                  border: 'none',
                  borderRadius: '0.5rem',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  background: active ? theme.button : theme.secondaryBg,
                  color: active ? theme.buttonText : theme.text,
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {phase === 'waiting-for-telegram' || (phase === 'loading' && !data) ? (
          <p style={{ color: theme.hint }}>Loading…</p>
        ) : null}

        {phase === 'error' ? <p style={{ color: theme.hint }}>{message}</p> : null}

        {data && phase !== 'error' ? (
          <div style={{ opacity: phase === 'loading' ? 0.5 : 1 }}>
            {data.channels.every((channel) => channel.sources.length === 0) ? (
              <p style={{ color: theme.hint }}>No sources yet. Add one in the chat with /addsource @username.</p>
            ) : null}

            {data.channels.map((channel) => {
              if (channel.sources.length === 0) return null;
              const totals = totalsOf(channel.sources);
              return (
                <section key={channel.id} style={{ marginBottom: '1.75rem' }}>
                  <h2
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      gap: '0.5rem',
                      fontSize: '1rem',
                      fontWeight: 700,
                      margin: '0 0 0.35rem',
                      paddingBottom: '0.35rem',
                      borderBottom: `2px solid ${theme.button}`,
                    }}
                  >
                    <span>📢 {channel.name}</span>
                    <span style={{ color: rateColour(totals.approvalRate) }}>{percent(totals.approvalRate)}</span>
                  </h2>

                  <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: theme.hint }}>
                    {channel.sources.length} {channel.sources.length === 1 ? 'source' : 'sources'} · {totals.posts} posts · {totals.approved} approved · X reads ≈{' '}
                    {dollars(totals.readCostUsd)} · {dollars(totals.costPerApprovedUsd)} per approved
                  </p>

                  {channel.sources.map((source) => (
                    <section
                      key={source.sourceId}
                      style={{
                        background: theme.secondaryBg,
                        borderRadius: '0.6rem',
                        padding: '0.75rem 0.9rem',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: '0.5rem',
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          @{source.username}
                          {source.enabled ? null : (
                            <span style={{ color: theme.hint, fontWeight: 400, fontSize: '0.8rem' }}> · paused</span>
                          )}
                        </span>
                        <span
                          style={{ fontWeight: 700, color: rateColour(source.approvalRate) }}
                          title="Approved of decided"
                        >
                          {percent(source.approvalRate)}
                        </span>
                      </div>

                      <div
                        aria-hidden
                        style={{
                          height: '0.35rem',
                          borderRadius: '0.2rem',
                          background: 'rgba(127,127,127,0.2)',
                          overflow: 'hidden',
                          margin: '0.45rem 0 0.55rem',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.round((source.approvalRate ?? 0) * 100)}%`,
                            background: rateColour(source.approvalRate),
                          }}
                        />
                      </div>

                      <div style={{ fontSize: '0.85rem' }}>
                        {source.posts} posts · ✅ {source.approved} · ❌ {source.rejected}
                        {source.waiting > 0 ? ` · ⏳ ${source.waiting}` : ''}
                        {source.notSent > 0 ? ` · not sent ${source.notSent}` : ''}
                      </div>

                      {source.rejectionReasons.length > 0 ? (
                        <div style={{ fontSize: '0.8rem', color: theme.hint, marginTop: '0.25rem' }}>
                          {source.rejectionReasons
                            .slice(0, 3)
                            .map((entry) => `${labelOf(entry.reason)} ${entry.count}`)
                            .join(' · ')}
                        </div>
                      ) : null}

                      <div style={{ fontSize: '0.8rem', color: theme.hint, marginTop: '0.25rem' }}>
                        X reads ≈ {dollars(source.readCostUsd)} · {dollars(source.costPerApprovedUsd)} per approved ·
                        last post {ago(source.lastPostAt)}
                      </div>
                    </section>
                  ))}
                </section>
              );
            })}

            <p style={{ fontSize: '0.75rem', color: theme.hint, margin: 0 }}>
              Approval rate is approved out of decided. X reads are an estimate at ${data.postReadUsd} per post the
              bot kept; posts X returned that it skipped are not counted, so the real figure is a little higher.
            </p>
          </div>
        ) : null}
      </main>
    </>
  );
}
