import { WalletProvider } from "@/providers/wallet-context";
import { MidnightProvidersProvider } from "@/providers/midnight-providers";
import { useRoute, type Route } from "~/router";
import { SessionProvider } from "~/session";
import { TxProvider } from "~/tx";
import { TopBar } from "~/components/top-bar";
import { Tray } from "~/components/tray";
import { BoardPage, OpenBoardPage } from "~/pages/board";
import { BountyPage } from "~/pages/bounty";
import { MinePage } from "~/pages/mine";
import { PostPage } from "~/pages/post";
import { PostStart, PostWorkPage } from "~/pages/post-work";
import { WorkPage } from "~/pages/work";
import { SetupPage } from "~/pages/setup";
import { IssuePage } from "~/pages/issue";
import { useTheme, type Theme } from "~/theme";
import { cx } from "~/components/ui";
import { BackupPage } from "~/pages/backup";

export function App() {
  return (
    <WalletProvider>
      <MidnightProvidersProvider>
        <TxProvider>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </TxProvider>
      </MidnightProvidersProvider>
    </WalletProvider>
  );
}

function Shell() {
  const route = useRoute();
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar route={route} />
      <main className="mx-auto box-border w-full max-w-[1240px] flex-1 px-4 pt-8 pb-20 sm:px-8 sm:pt-12">
        <Page route={route} />
      </main>
      <Footer />
      <Tray />
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "setup":
      return <SetupPage />;
    case "issue":
      return <IssuePage />;
    case "backup":
      return <BackupPage />;
    case "open-board":
      return <OpenBoardPage route={route} />;
    case "post":
      return <PostStart />;
    case "post-answer":
      return <PostPage />;
    case "post-work":
      return <PostWorkPage />;
    case "work":
      return <WorkPage route={route} />;
    case "mine":
      return <MinePage />;
    case "bounty":
      return <BountyPage route={route} />;
    case "board":
      return <BoardPage />;
  }
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const options: [Theme, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return (
    <div role="group" aria-label="Theme" className="inline-flex rounded-md border border-line p-0.5">
      {options.map(([t, label]) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => setTheme(t)}
          className={cx("h-6 rounded-[5px] px-2 text-xs font-medium transition-colors", theme === t ? "bg-chip text-fg" : "text-faint hover:text-fg")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Footer() {
  const link = "text-faint no-underline hover:text-fg";
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 px-4 pt-6 pb-8 text-[13px] text-faint sm:px-8">
        <span className="flex flex-wrap items-center gap-4">
          Private Bounties · open source, built on Midnight
          <ThemeSwitch />
        </span>
        <nav aria-label="Footer" className="flex flex-wrap gap-5">
          <a className={link} href="https://github.com/Kanasjnr/Midnight-private-bounties" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className={link} href="https://github.com/Kanasjnr/Midnight-private-bounties/blob/main/ARCHITECTURE.md" target="_blank" rel="noreferrer">
            Design notes
          </a>
          <a className={link} href="https://github.com/Kanasjnr/Midnight-private-bounties/issues" target="_blank" rel="noreferrer">
            Report a problem
          </a>
          <a className={link} href="#/issue">
            Issue signed records
          </a>
          <a className={link} href="https://docs.midnight.network" target="_blank" rel="noreferrer">
            Midnight docs
          </a>
        </nav>
      </div>
    </footer>
  );
}
