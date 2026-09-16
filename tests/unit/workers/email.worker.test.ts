// tests/unit/workers/email.worker.test.ts
//
// Pure-logic coverage of processEmailJob's retry decision, with sendMail
// mocked — starting a real Worker/Redis connection belongs to
// tests/integration/workers/email.worker.test.ts, per this repo's own
// unit/integration split (CLAUDE.md).
import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailJobData } from '@/jobs/email.job'
import * as mailerService from '@/services/mailer.service'
import { processEmailJob } from '@/workers/email.worker'

vi.mock('@/services/mailer.service', () => ({
  sendMail: vi.fn(),
}))

/**
 * A minimal stand-in for a BullMQ `Job<EmailJobData>` — only the properties
 * `processEmailJob` actually reads (`id`, `data`). Cast via `unknown`, not
 * `never`: this is a deliberately partial object standing in for the real
 * `Job` class BullMQ constructs, not a value processEmailJob should ever be
 * handed for real.
 * @returns A fake job for processEmailJob to process.
 */
function mockJob(): Job<EmailJobData> {
  return {
    id: 'test-job-1',
    data: {
      to: 'user@example.com',
      templateKey: 'email_verification',
      variables: {
        firstName: 'Ada',
        verificationUrl: 'https://example.com/verify?token=abc',
        appName: 'Test',
      },
      userId: 'user-123',
    },
  } as unknown as Job<EmailJobData>
}

describe('processEmailJob', () => {
  // This project's vitest config sets neither restoreMocks nor mockReset
  // (see tests/helpers/mutate.ts's own header comment for the same fact),
  // so a mockResolvedValue set by one test would otherwise leak into the
  // next.
  beforeEach(() => {
    vi.mocked(mailerService.sendMail).mockReset()
  })

  it('resolves when sendMail returns sent', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('sent')
    await expect(processEmailJob(mockJob())).resolves.toBeUndefined()
    expect(mailerService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@example.com', templateKey: 'email_verification' })
    )
  })

  it('throws when sendMail returns failed so BullMQ retries', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob())).rejects.toThrow(/Email job/)
  })

  it('does not include the recipient address in the thrown error message', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob())).rejects.toThrow(
      expect.not.stringContaining('user@example.com')
    )
  })

  it('includes the job id and templateKey in the thrown error, for operator triage', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob())).rejects.toThrow(/test-job-1.*email_verification/)
  })
})
