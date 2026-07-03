import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Public legal pages (no auth shell) — Privacy Policy + Data Deletion. These exist primarily to
 * satisfy Instagram / Meta App Review, which requires a public Privacy Policy URL and a Data
 * Deletion Instructions (or callback) URL. Written to reflect what Atlavue actually does; the
 * owner should review the contact address, effective date and jurisdiction before submitting.
 */

const UPDATED = '3 July 2026';
const CONTACT = 'schulmannn@gmail.com';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
        <header className="flex items-center justify-between gap-4 border-b border-border pb-5">
          <Link to="/" className="flex items-center gap-2.5">
            <svg className="h-6 w-6 text-primary" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2 3 6.5 12 11l9-4.5L12 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M3 12l9 4.5L21 12M3 17.5 12 22l9-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity="0.55" />
            </svg>
            <span className="text-base font-medium tracking-tight">Atlavue</span>
          </Link>
          <a href="https://atlavue.app" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            atlavue.app
          </a>
        </header>

        <main className="prose-legal mt-8">
          <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Last updated: {UPDATED}</p>
          <div className="mt-6 space-y-6 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
        </main>

        <footer className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-5 text-xs text-muted-foreground">
          <Link to="/privacy" className="transition-colors hover:text-foreground">Privacy Policy</Link>
          <Link to="/data-deletion" className="transition-colors hover:text-foreground">Data Deletion</Link>
          <span className="text-border">·</span>
          <a href={`mailto:${CONTACT}`} className="transition-colors hover:text-foreground">{CONTACT}</a>
        </footer>
      </div>
    </div>
  );
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-medium text-foreground">{children}</h2>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <H2>{title}</H2>
      {children}
    </section>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        Atlavue (“Atlavue”, “we”, “us”) is a social-media analytics service for Telegram and
        Instagram. This policy explains what we collect when you connect a source, why we collect
        it, how we protect it, and the choices you have. Questions: <a className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <Section title="1. Information we collect">
        <ul className="list-disc space-y-1.5 pl-5">
          <li><span className="font-medium text-foreground">Account data.</span> Your email address and a hashed password, used to sign in and to send report emails you request.</li>
          <li><span className="font-medium text-foreground">Telegram data.</span> Public statistics for channels you connect — subscriber counts, post views, reactions, forwards, and post metadata. This is collected either by a collector agent that you run yourself (in which case your Telegram session stays on your own device and is never sent to us) or, if you use an in-app connection, via a session you explicitly authorize, which we store encrypted.</li>
          <li><span className="font-medium text-foreground">Instagram data.</span> When you authorize Atlavue through Instagram Login, we access your Business or Creator account’s insights (reach, views, audience and follower demographics, and metrics for media, reels and stories) and basic profile information (username and account id). We receive an access token — never your Instagram password.</li>
          <li><span className="font-medium text-foreground">Technical logs.</span> Minimal server logs for reliability, security and abuse prevention.</li>
        </ul>
      </Section>

      <Section title="2. How we use your data">
        <p>We use it solely to provide the service to you: to show your analytics dashboards, compute trends, and — only if you enable it — send scheduled report emails. We do not use your data for advertising, profiling for third parties, or any purpose unrelated to the analytics you asked for.</p>
      </Section>

      <Section title="3. Consent and legal basis">
        <p>We process each source’s data on the basis of your explicit consent, given when you connect that source, and to perform the service you requested. You can withdraw consent at any time by disconnecting the source (see Data Deletion).</p>
      </Section>

      <Section title="4. How we share data">
        <p>We do not sell or rent your data, and we do not share it for advertising. We rely on a small number of processors to operate the service:</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li><span className="font-medium text-foreground">Railway</span> — application hosting and database.</li>
          <li><span className="font-medium text-foreground">Resend</span> — transactional and report emails.</li>
          <li><span className="font-medium text-foreground">Telegram</span> and <span className="font-medium text-foreground">Meta / Instagram</span> — the platforms your analytics originate from.</li>
        </ul>
      </Section>

      <Section title="5. Storage and security">
        <p>Data is hosted on Railway. Instagram access tokens and any authorized Telegram sessions are encrypted at rest using AES-256-GCM; passwords are hashed with scrypt. Your data is isolated to your account (multi-tenant isolation), and tokens are never exposed to the browser or to other users.</p>
      </Section>

      <Section title="6. Data retention">
        <p>We keep your analytics for as long as your account and the corresponding connection are active, plus daily aggregates used to draw historical charts. Disconnecting a source stops new collection; deleting your account removes your data. See the <Link to="/data-deletion" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">Data Deletion</Link> page.</p>
      </Section>

      <Section title="7. Your rights">
        <p>You may request access to, correction of, or deletion of your personal data, obtain a copy of it, and withdraw consent. To exercise any of these, disconnect the source in the app or email us at <a className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" href={`mailto:${CONTACT}`}>{CONTACT}</a>. We respond within 30 days.</p>
      </Section>

      <Section title="8. Instagram / Meta">
        <p>We comply with the Meta Platform Terms and Developer Policies. Disconnecting Instagram inside Atlavue immediately revokes and deletes the stored token. You can also remove Atlavue at Instagram → Settings → Apps and Websites. Removing our access there also signals us to delete the associated Instagram data. Details on the <Link to="/data-deletion" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">Data Deletion</Link> page.</p>
      </Section>

      <Section title="9. Telegram">
        <p>Telegram does not offer OAuth. You connect either through a collector agent you run yourself — in which case your Telegram session never leaves your device — or through an in-app session you can revoke at any time in Telegram (Settings → Devices) and in Atlavue.</p>
      </Section>

      <Section title="10. Children">
        <p>Atlavue is not directed to children under the age of 13 (or the minimum age required in your country), and we do not knowingly collect their data.</p>
      </Section>

      <Section title="11. Changes to this policy">
        <p>We may update this policy from time to time. When we do, we will revise the “Last updated” date above. Material changes will be communicated in the app or by email.</p>
      </Section>

      <Section title="12. Contact">
        <p>For any privacy question or request, contact <a className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
      </Section>
    </LegalPage>
  );
}

export function DataDeletion() {
  return (
    <LegalPage title="Data Deletion">
      <p>
        You are in control of your data in Atlavue. This page explains how to disconnect a source
        and how to permanently delete your account and all associated data. It also serves as our
        Data Deletion Instructions for the Instagram Platform.
      </p>

      <Section title="1. Disconnect Instagram">
        <p>In Atlavue, open <span className="font-medium text-foreground">Connect</span> (or Settings → Instagram) and click <span className="font-medium text-foreground">Disconnect</span>. This immediately revokes and deletes the stored access token. You can also remove Atlavue at <span className="font-medium text-foreground">Instagram → Settings → Apps and Websites</span>; removing our access there also triggers deletion of the associated Instagram data on our side.</p>
      </Section>

      <Section title="2. Disconnect Telegram">
        <p>Revoke the channel’s API key in <span className="font-medium text-foreground">Settings</span> (this stops the collector agent), or — if you connected an in-app session — click <span className="font-medium text-foreground">Disconnect</span> in Atlavue and remove the linked device in Telegram (Settings → Devices).</p>
      </Section>

      <Section title="3. Delete your account and all data">
        <p>To erase everything, email us at <a className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" href={`mailto:${CONTACT}?subject=Delete%20my%20account`}>{CONTACT}</a> from your account email address with the subject “Delete my account”. We remove your account, all connected-source data, tokens, and archived aggregates within 30 days; backups are purged on their normal rotation.</p>
      </Section>

      <Section title="4. What we retain">
        <p>After deletion we keep only minimal security and legal records that contain no analytics content, for a limited period required by law, after which they are erased too.</p>
      </Section>

      <Section title="5. Contact">
        <p>Questions about deleting your data? Contact <a className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
      </Section>
    </LegalPage>
  );
}
