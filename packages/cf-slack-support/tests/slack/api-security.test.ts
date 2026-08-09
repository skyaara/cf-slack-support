import { describe, expect, it, vi } from 'vitest';
import { createSlackClient } from '../../src/slack';

describe('Slack client security', () => {
  it('never sends the bot token to an untrusted file origin', async () => {
    const fetchMock = vi.fn();
    const slack = createSlackClient({
      botToken: 'xoxb-sensitive',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      slack.downloadPrivateFile('https://attacker.example/file.png', 1024),
    ).rejects.toThrow('untrusted origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops reading Slack files once the configured limit is exceeded', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array(2048), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const slack = createSlackClient({
      botToken: 'xoxb-sensitive',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      slack.downloadPrivateFile('https://files.slack.com/files-pri/test.png', 1024),
    ).rejects.toThrow('exceeds 1024 bytes');
  });
});
