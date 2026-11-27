/**
 * The code a refusal to publish to a channel that is not connected yet
 * carries (src/lib/publishing/channel.ts), for pages to tell it from other
 * errors and offer to connect the channel. Kept free of imports, so a page
 * can use it without pulling in the server's code.
 */
export const CHANNEL_NOT_CONNECTED = 'channel_not_connected';

/** Where Settings shows the channel to connect, on each surface. */
export const PUBLISHING_CHANNEL_ANCHOR = 'publishing-channel';
