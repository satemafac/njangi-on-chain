// VerificationRequiredModal.tsx — Assistive replacement for the dead-end
// "KYC check has expired" toast on compliance-gated rounds.
//
// There is no self-serve KYC flow yet: ComplianceAttestations are issued
// by the operator's attestor key, arranged through the circle admin. This
// modal tells the member exactly that instead of pointing them at a "ramp
// partner flow" that cannot mint an attestation. When a self-serve
// verification flow ships, its entry point belongs on the primary button
// here.
//
// Visual language mirrors BillingUpsellModal (paper surface, ink text,
// pill buttons) so gate interruptions feel like one product.

import React from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldCheck, X } from 'lucide-react';

export interface VerificationRequiredModalProps {
  open: boolean;
  onClose: () => void;
}

export function VerificationRequiredModal({
  open,
  onClose,
}: VerificationRequiredModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[#14161c]/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-[#dfd6ca] bg-[#fbfaf7] p-6 shadow-[0_28px_80px_-40px_rgba(15,23,42,0.45)] sm:p-7">
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#d6e0d2] bg-[#f3f7f1]">
            <ShieldCheck className="h-5 w-5 text-[#3f7d54]" />
          </div>

          <Dialog.Title className="mt-4 pr-8 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
            Identity verification needed
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-[#5d6674]">
            This circle requires a one-time identity check before you can
            contribute or collect. Your circle admin arranges verification
            for members — ask them to start yours. Once you&apos;re
            verified, come back and your payment will go through normally.
          </Dialog.Description>

          <div className="mt-5 flex items-start gap-3 rounded-[18px] border border-[#e9e1d6] bg-white p-3.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#3f7d54]" />
            <p className="text-xs leading-5 text-[#4b5565]">
              Verification is recorded on-chain as a compliance attestation
              tied to your wallet. Njangi On-Chain never sees or stores your
              identity documents.
            </p>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Link
              href="/faq#security-&-trust"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-full border border-[#d5ccbf] bg-white px-5 py-2.5 text-sm font-semibold text-[#334155] transition-colors duration-200 hover:bg-[#f6f3ee]"
            >
              How verification works
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723]"
            >
              Got it
            </button>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              onClick={onClose}
              className="absolute right-5 top-5 rounded-full border border-[#e5ddd2] bg-white p-2 text-[#667085] transition-colors duration-200 hover:text-[#171923]"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default VerificationRequiredModal;
