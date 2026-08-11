import { useState } from 'react';
import { Button } from '../ui/Button';
import { useApi, useExtractionJobs, type ExtractionJob } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import './photoImport.css';

/**
 * Photograph a hand-written document and let AI read it.
 *
 * This is the path the whole extraction pipeline was built for and could not reach: the
 * extraction Lambda triggers on `s3:ObjectCreated` under `uploads/`, but nothing could put a file
 * in the bucket, because the browser holds no AWS credentials and must never be given any.
 *
 * Flow: ask the API to presign a PUT, upload straight to S3, then watch the review queue. The
 * upload deliberately does NOT go through the API — a photo of a revenue sheet is megabytes,
 * API Gateway caps a request at 10 MB, and a slow phone connection would otherwise hold a Lambda
 * open for its duration.
 *
 * **Nothing is applied automatically.** AI reads the sheet; a manager confirms it in the review
 * queue before it becomes payroll data. A misread figure that silently became someone's revenue
 * share would be far worse than a slow workflow.
 */
export function PhotoImport({ docType }: { docType: 'revenue' | 'schedule' }) {
  const api = useApi();
  const { getToken } = useAuth();
  const jobs = useExtractionJobs('needs_review');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUploaded(null);
    if (!file) {
      setError(t.photo.chooseFirst);
      return;
    }
    setBusy(true);
    try {
      // 1. Presign. The API validates the media type here, so an unreadable format fails now
      //    with a clear message rather than becoming a rejected extraction job later.
      const signed = await api.post<{ url: string; key: string }>('/api/uploads', {
        docType,
        contentType: file.type,
        filename: file.name,
      });

      // 2. PUT straight to S3. No Authorization header — the signature IS the credential, and
      //    sending a bearer token to S3 would make it reject the request.
      const put = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`${t.photo.uploadFailed} (${put.status})`);

      setUploaded(signed.key);
      setFile(null);
      // The extraction Lambda runs asynchronously; refetch so the queue below picks the job up
      // once Bedrock has read the document.
      void jobs.refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Photographs only reach the API's allowlist; naming them here means the file picker itself
  // filters, instead of the manager discovering the limit after choosing.
  const accept = 'image/jpeg,image/png,image/webp,image/gif,application/pdf';
  const pending = (jobs.data ?? []).filter((j: ExtractionJob) => j.docType === docType);

  return (
    <form onSubmit={upload}>
      <p className="muted">{t.photo.hint}</p>

      <div className="field field--wide">
        <label className="field__label" htmlFor="photo">
          {t.photo.file}
        </label>
        <input
          id="photo"
          className="field__file"
          type="file"
          accept={accept}
          // capture="environment" makes a phone open the camera directly rather than the photo
          // library, which is what a manager standing at the counter actually wants.
          capture="environment"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      <Button type="submit" variant="primary" block disabled={busy || !file}>
        {busy ? t.photo.uploading : t.photo.upload}
      </Button>

      {/*
       * Both outcomes are announced. The upload is asynchronous and nothing else on screen moves
       * when it finishes — the file input clears, which a sighted user reads as success and a
       * screen-reader user gets nothing from at all. This is also the flow most likely to be used
       * one-handed on a phone behind a counter.
       */}
      {error ? <p className="form__error photo__result" role="status">{error}</p> : null}
      {uploaded ? <p className="photo__ok" role="status">{t.photo.uploaded}</p> : null}

      {pending.length > 0 ? <p className="muted photo__queue">{t.photo.inQueue(pending.length)}</p> : null}
    </form>
  );
}
