import React from 'react';
import { Check, LoaderCircle, ShieldCheck, X } from 'lucide-react';

type CallbackTone = 'processing' | 'success' | 'error';

type CallbackStatusShellProps = {
  tone: CallbackTone;
  status: string;
  progress: number;
  eyebrow?: string;
  lead: string;
  helper: string;
  chips?: string[];
};

const STEPS = [
  'Validate provider response',
  'Generate zkLogin proof',
  'Restore wallet session',
];

function clampProgress(progress: number) {
  return Math.max(0, Math.min(progress, 100));
}

export function CallbackStatusShell({
  tone,
  status,
  progress,
  eyebrow = 'Authentication callback',
  lead,
  helper,
  chips = ['OAuth callback', 'zkLogin proof', 'Secure redirect'],
}: CallbackStatusShellProps) {
  const normalizedProgress = clampProgress(progress);
  const isError = tone === 'error';
  const isSuccess = tone === 'success';

  const Icon = isError ? X : isSuccess ? Check : LoaderCircle;
  const iconToneClass = isError
    ? 'border-[#ebd0cb] bg-[#fbf1ef] text-[#a1493c]'
    : isSuccess
      ? 'border-[#d6e0d2] bg-[#f3f7f1] text-[#365243]'
      : 'border-[#d8d5ce] bg-white text-[#455468]';
  const progressToneClass = isSuccess
    ? 'bg-[#365243]'
    : 'bg-[#171923]';

  return (
    <div className="relative isolate min-h-screen overflow-hidden bg-[#f5f1e8] text-[#171923]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(circle_at_top,rgba(112,129,155,0.18),transparent_68%)]" />
      <main className="relative mx-auto flex min-h-screen max-w-6xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid w-full gap-8 rounded-[32px] border border-[#e6ded0] bg-white/95 p-6 shadow-[0_30px_90px_-48px_rgba(15,23,42,0.3)] backdrop-blur sm:p-8 lg:grid-cols-[minmax(0,1.05fr)_420px] lg:p-10">
          <section className="flex flex-col justify-between gap-8">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-3 rounded-full border border-[#ddd4c5] bg-[#fcfbf8] px-3 py-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e8dfd2] bg-white">
                  <ShieldCheck className="h-4 w-4 text-[#455468]" />
                </span>
                <span className="text-[0.72rem] font-semibold uppercase tracking-[0.32em] text-[#6b7280]">
                  {eyebrow}
                </span>
              </div>

              <div className="space-y-4">
                <h1 className="text-4xl font-semibold tracking-[-0.05em] text-[#171923] sm:text-[3.4rem]">
                  Secure sign-in handoff
                </h1>
                <p className="max-w-2xl text-base leading-8 text-[#5f6b7f]">
                  {lead}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                {chips.map((chip) => (
                  <span
                    key={chip}
                    className="inline-flex items-center rounded-full border border-[#ddd4c5] bg-white px-4 py-2 text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-[#64748b]"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-[24px] border border-[#e8dfd2] bg-[#fcfbf8] p-5 shadow-[0_24px_60px_-42px_rgba(15,23,42,0.2)] sm:p-6">
              <p className="text-[0.72rem] font-semibold uppercase tracking-[0.32em] text-[#6b7280]">
                What happens here
              </p>
              <p className="mt-4 text-sm leading-7 text-[#667085]">
                Njangi On-Chain validates the OAuth response, prepares your zero-knowledge
                proof, and restores the correct wallet session before sending you
                back into the app.
              </p>
            </div>
          </section>

          <section className="rounded-[28px] border border-[#e8dfd2] bg-[#fcfbf8] p-6 shadow-[0_24px_60px_-42px_rgba(15,23,42,0.2)] sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-3">
                <p className="text-[0.72rem] font-semibold uppercase tracking-[0.32em] text-[#6b7280]">
                  Current status
                </p>
                <h2 className="text-3xl font-semibold tracking-[-0.05em] text-[#171923] sm:text-[2.6rem]">
                  {status}
                </h2>
              </div>

              <div
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border ${iconToneClass}`}
              >
                <Icon
                  className={`h-6 w-6 ${
                    tone === 'processing' ? 'animate-spin' : ''
                  }`}
                />
              </div>
            </div>

            <p className="mt-4 text-base leading-8 text-[#5f6b7f]">{helper}</p>

            {!isError ? (
              <>
                <div className="mt-8 flex items-center justify-between text-sm font-medium text-[#455468]">
                  <span>Progress</span>
                  <span>{Math.round(normalizedProgress)}%</span>
                </div>
                <div className="mt-3 h-2 rounded-full bg-[#ece4d7]">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ease-out ${progressToneClass}`}
                    style={{ width: `${normalizedProgress}%` }}
                  />
                </div>

                <div className="mt-6 space-y-3">
                  {STEPS.map((step, index) => {
                    const threshold = index * 34;
                    const isStepComplete =
                      isSuccess || normalizedProgress >= threshold + 30;
                    const isStepActive =
                      !isSuccess &&
                      normalizedProgress >= threshold &&
                      normalizedProgress < threshold + 30;

                    return (
                      <div
                        key={step}
                        className={`flex items-center justify-between gap-4 rounded-[20px] border px-4 py-3 ${
                          isStepComplete || isStepActive
                            ? 'border-[#ddd4c5] bg-white text-[#171923]'
                            : 'border-[#e8dfd2] bg-[#f7f4ee] text-[#667085]'
                        }`}
                      >
                        <span className="text-sm font-medium">{step}</span>
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                            isStepComplete
                              ? 'bg-[#171923] text-white'
                              : isStepActive
                                ? 'border border-[#d8cfbf] bg-[#fcfbf8] text-[#455468]'
                                : 'border border-[#dfd6c8] bg-white text-[#98a2b3]'
                          }`}
                        >
                          {index + 1}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="mt-8 rounded-[20px] border border-[#e8dfd2] bg-white p-4">
                <p className="text-[0.72rem] font-semibold uppercase tracking-[0.32em] text-[#6b7280]">
                  Recovery
                </p>
                <p className="mt-4 text-sm leading-7 text-[#667085]">
                  The current sign-in attempt could not be completed. You&apos;ll be
                  taken back to the entry point so you can retry with a clean
                  session.
                </p>
              </div>
            )}

            <div className="mt-8 rounded-[20px] border border-[#e8dfd2] bg-white p-4 text-sm leading-7 text-[#455468]">
              Njangi On-Chain completes sign-in with zkLogin on Sui and restores
              your wallet state before redirecting away from this screen.
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
