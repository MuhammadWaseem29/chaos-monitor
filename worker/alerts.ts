import type { Env } from "./env";

export function alertsEnabled(env: Env) {
  return Boolean(env.DISCORD_WEBHOOK || (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID));
}

export function wantsProgram(env: Env, slug: string) {
  const list = (env.ALERT_PROGRAMS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || list.includes(slug.toLowerCase());
}

/** Sends one message to every configured channel. Never throws. */
export async function sendAlert(env: Env, text: string) {
  const jobs: Promise<unknown>[] = [];
  if (env.DISCORD_WEBHOOK) {
    jobs.push(
      fetch(env.DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, 1900) }),
      }),
    );
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
      }),
    );
  }
  await Promise.allSettled(jobs);
}

export function newHostsMessage(program: string, root: string, hosts: string[]) {
  const shown = hosts.slice(0, 25).join("\n");
  const more = hosts.length > 25 ? `\n… +${hosts.length - 25} more` : "";
  return `🆕 ${hosts.length} new subdomain${hosts.length === 1 ? "" : "s"} · ${program} · ${root}\n${shown}${more}`;
}
