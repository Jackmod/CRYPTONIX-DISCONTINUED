import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { describeError, type BotCommand } from './types.js';
import type { TrackedHandle } from '../engine/client.js';

/** Amber, not green or red: a followed account is not a gain or a loss. */
const PHOSPHOR = 0xffb000;

/** Discord rejects an embed description over this rather than truncating it. */
const MAX_DESCRIPTION = 4096;
/**
 * Accounts listed in one reply.
 *
 * The list is shared across every server and has no hard cap, so a long one
 * would otherwise blow the description limit and fail the whole command.
 */
const MAX_LISTED = 60;

export function buildFollowingEmbed(handles: TrackedHandle[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(PHOSPHOR).setTitle('Followed accounts').setTimestamp(new Date());

  if (handles.length === 0) {
    return embed.setDescription('Not following anyone yet. Add one with `/track twitter`.');
  }

  const ordered = [...handles].sort((a, b) => a.handle.localeCompare(b.handle));
  const shown = ordered.slice(0, MAX_LISTED);

  // No escaping needed and none applied: a handle is validated against
  // [A-Za-z0-9_]{1,15} before it is ever stored, so it cannot carry markdown.
  const lines = shown.map((h) => {
    const waiting = h.lastTweetId === null ? ' · waiting for the first check' : '';
    return `· [@${h.handle}](https://x.com/${h.handle})${waiting}`;
  });

  if (ordered.length > shown.length) {
    lines.push(`…and ${ordered.length - shown.length} more. The desktop app shows the full list.`);
  }

  let description = lines.join('\n');
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;

  return embed
    .setDescription(description)
    .setFooter({ text: `${ordered.length} account${ordered.length === 1 ? '' : 's'}` });
}

export const followingCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('following')
    .setDescription('List the X accounts Cryptonix is following')
    // Read-only, but it exposes the shared list. In a DM there is no server
    // whose membership could gate that — the same reasoning as /wallets.
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, { engine }) {
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply('⚠️ This command only works inside a server, not in a DM.');
      return;
    }

    try {
      const handles = await engine.listHandles();
      await interaction.editReply({ embeds: [buildFollowingEmbed(handles)] });
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
