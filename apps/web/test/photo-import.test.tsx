import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';

/**
 * Photographing a hand-written document for AI extraction.
 *
 * This is the path the extraction pipeline was built for and could not reach: the Lambda triggers
 * on `s3:ObjectCreated` under `uploads/`, but nothing could put a file in the bucket, because the
 * browser holds no AWS credentials and must never be given any.
 *
 * The assertions that matter are about WHERE the bytes go: straight to S3 via a presigned PUT,
 * not through the API. A photo is megabytes, API Gateway caps a request at 10 MB, and routing it
 * through a Lambda would hold one open for the length of a phone upload.
 */

const post = vi.fn();
const refetch = vi.fn();
vi.mock('../src/lib/queries', () => ({
  useApi: () => ({ post }),
  useExtractionJobs: () => ({ data: [], isLoading: false, error: null, refetch }),
}));
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ getToken: async () => 'tok' }) }));

const { PhotoImport } = await import('../src/routes/PhotoImport');

const photo = () => new File(['bytes'], 'sheet.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  post.mockReset();
  refetch.mockReset();
  post.mockResolvedValue({ url: 'https://bucket.s3.amazonaws.com/uploads/revenue/x-sheet.jpg?sig', key: 'uploads/revenue/x-sheet.jpg' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
});

describe('PhotoImport', () => {
  it('asks the API to presign, then PUTs the bytes to S3 directly', async () => {
    const user = userEvent.setup();
    render(<PhotoImport docType="revenue" />);
    await user.upload(screen.getByLabelText(t.photo.file), photo());
    await user.click(screen.getByRole('button', { name: t.photo.upload }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    // The docType decides the S3 prefix, which is what the extraction trigger parses.
    expect(post).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({
      docType: 'revenue',
      contentType: 'image/jpeg',
      filename: 'sheet.jpg',
    }));

    const put = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(put[0]).toContain('s3.amazonaws.com');
    expect(put[1].method).toBe('PUT');
    // The signature IS the credential. Sending a bearer token makes S3 reject the request.
    expect(JSON.stringify(put[1].headers ?? {})).not.toMatch(/authorization/i);
  });

  it('tells the manager the data is not applied yet', async () => {
    // A misread figure that silently became someone's revenue share is far worse than a slow
    // workflow, so the copy has to say a human confirms it.
    render(<PhotoImport docType="revenue" />);
    expect(screen.getByText(t.photo.hint)).toBeInTheDocument();
  });

  it('refetches the review queue after a successful upload', async () => {
    const user = userEvent.setup();
    render(<PhotoImport docType="revenue" />);
    await user.upload(screen.getByLabelText(t.photo.file), photo());
    await user.click(screen.getByRole('button', { name: t.photo.upload }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it('surfaces an S3 failure instead of claiming success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    const user = userEvent.setup();
    render(<PhotoImport docType="revenue" />);
    await user.upload(screen.getByLabelText(t.photo.file), photo());
    await user.click(screen.getByRole('button', { name: t.photo.upload }));
    expect(await screen.findByText(/403/)).toBeInTheDocument();
    expect(screen.queryByText(t.photo.uploaded)).not.toBeInTheDocument();
  });

  it('surfaces a presign rejection, e.g. an unsupported media type', async () => {
    post.mockRejectedValue(new Error('unsupported media type'));
    const user = userEvent.setup();
    render(<PhotoImport docType="revenue" />);
    await user.upload(screen.getByLabelText(t.photo.file), photo());
    await user.click(screen.getByRole('button', { name: t.photo.upload }));
    expect(await screen.findByText('unsupported media type')).toBeInTheDocument();
    // Nothing was uploaded, so nothing should have been sent to S3.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps the upload button disabled until a file is chosen', () => {
    render(<PhotoImport docType="revenue" />);
    expect(screen.getByRole('button', { name: t.photo.upload })).toBeDisabled();
  });

  it('uses the schedule prefix when importing a schedule photo', async () => {
    const user = userEvent.setup();
    render(<PhotoImport docType="schedule" />);
    await user.upload(screen.getByLabelText(t.photo.file), photo());
    await user.click(screen.getByRole('button', { name: t.photo.upload }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ docType: 'schedule' });
  });
});
