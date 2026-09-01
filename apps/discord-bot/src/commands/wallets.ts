import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { describeError, displayLabel, shortAddress, type BotCommand } from './types.js';
import type { Wallet } from '../engine/client.js';

const PHOSPHOR = 0xffb000;

/** Discord truncates nothing for you: an embed description over this is rejected. */
const MAX_DESCRIPTION = 4096;
/**
 * Wallets listed in one reply.
 *
 * The list is shared across every server and has no hard cap, so a long one
 * would otherwise blow the description limit and fail the whole command.
 */
const MAX_LISTED = 40;

export function buildWalletsEmbed(wallets: Wallet[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(PHOSPHOR).setTitle('Tracked wallets').setTimestamp(new Date());

  if (wallets.length === 0) {
    return embed.setDescription('Nothing is tracked yet. Add one with `/track wallet`.');
  }

  // Your own first, then alphabetically — the same order the desktop app uses.
  const ordered = [...wallets].sort((a, b) => {
    if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  const shown = ordered.slice(0, MAX_LISTED);
  const lines = shown.map((wallet) => {
    // A label is free text from whoever tracked it. Backticks would break out
    // of the code span, and markdown would let it style the whole line.
    const label = escapeMarkdown(displayLabel(wallet));
    const status = wallet.backfillStatus === 'done' ? '' : ` · ${wallet.backfillStatus}`;
    return `${wallet.isMine ? '★' : '·'} **${label}** — \`${shortAddress(wallet.address)}\`${status}`;
  });

  if (ordered.length > shown.length) {
    lines.push(`…and ${ordered.length - shown.length} more. The desktop app shows the full list.`);
  }

  let description = lines.join('\n');
  if (description.length > MAX_DESCRIPTION) {
    description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  }

  return embed
    .setDescription(description)
    .setFooter({ text: `${ordered.length} wallet${ordered.length === 1 ? '' : 's'} · ★ marks your own` });
}

/** Neutralises the markdown a label could otherwise inject into the list. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~|>[\]()#-])/g, '\\$1');
}

export const walletsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('wallets')
    .setDescription('List the wallets Cryptonix is tracking')
    // Read-only, but it exposes the shared wallet list. In a DM there is no
    // server whose membership could gate that, so keep it in guilds — the
    // same reasoning as /pnl.
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, { engine }) {
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply('⚠️ This command only works inside a server, not in a DM.');
      return;
    }

    try {
      const wallets = await engine.listWallets();
      await interaction.editReply({ embeds: [buildWalletsEmbed(wallets)] });
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
