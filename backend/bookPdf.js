/**
 * bookPdf.js
 *
 * Access to the CLA book PDFs held in S3. A link is only handed out after S3 confirms the
 * file can be read, so a reader is never sent to a raw S3 error page; when the PDF cannot
 * be reached the caller falls back to the book-page text view.
 */

const S3_BOOK_FILES = [
  "Basic Concepts of Company & It's Structure_PRINT.pdf",
  'Basic_Concepts_of_Company_and_Its_Structure_PRINT.pdf',
  'Company Finance, Investment & Audit_PRINT.pdf',
  'Company_Finance_Investment_and_Audit_PRINT.pdf',
  'Corporate Compliance & Law_PRINT.pdf',
  'Corporate Dispute & Remedies_PRINT.pdf',
  'Corporate_Compliance_and_Law_PRINT.pdf',
  'Corporate_Dispute_and_Remedies_PRINT.pdf',
  'Key Managerial Personnel_PRINT.pdf',
  'Key_Managerial_Personnel_PRINT.pdf',
  'Legal Doctrines & Principles_PRINT.pdf',
  'Legal_Doctrines_and_Principles_PRINT.pdf',
  'Meetings & Governance_PRINT.pdf',
  'Meetings_and_Governance_PRINT.pdf',
  'Share Capital & Securities Law_PRINT (1).pdf',
  'Share_Capital_and_Securities_Law_PRINT.pdf',
  'Share_Capital_and_Securities_Law_PRINT_1.pdf',
];

const AVAILABLE_TTL_MS = 10 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 60 * 1000;
const availabilityCache = new Map();
let s3Client = null;

const squash = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveBookKey(rawFileName) {
  let fileName = String(rawFileName || '').trim();
  if (!fileName || ['unknown', 'null', 'undefined'].includes(fileName.toLowerCase())) return null;
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';
  const wanted = squash(fileName);
  const match = S3_BOOK_FILES.find((b) => squash(b) === wanted) ||
    S3_BOOK_FILES.find((b) => wanted.length > 8 && (squash(b).includes(wanted) || wanted.includes(squash(b)))) ||
    fileName;
  return `books/${match.replace(/^books\//, '')}`;
}

function getClient() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null;
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

const bucketName = () => process.env.AWS_BUCKET_NAME || 'james-fixer';

/**
 * Resolves to { available: true, key } when S3 confirms the PDF is readable,
 * otherwise { available: false, reason }.
 */
async function checkBookPdf(fileName) {
  const key = resolveBookKey(fileName);
  if (!key) return { available: false, reason: 'No book file name was given.' };

  const cached = availabilityCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;

  let result;
  const client = getClient();
  if (!client) {
    result = { available: false, reason: 'AWS credentials are not configured on the server.' };
  } else {
    try {
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      await client.send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
      result = { available: true, key };
    } catch (error) {
      const code = error?.name || error?.Code || 'Error';
      const status = error?.$metadata?.httpStatusCode;
      result = { available: false, reason: `${code}${status ? ` (HTTP ${status})` : ''}: ${error?.message || 'S3 request failed'}` };
      console.error(`[Book PDF] ${key} is not reachable in S3 bucket "${bucketName()}": ${result.reason}`);
    }
  }
  availabilityCache.set(key, { result, expires: Date.now() + (result.available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS) });
  return result;
}

async function presignBookPdf(key, expiresInSeconds = 7200) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getClient(), new GetObjectCommand({
    Bucket: bucketName(),
    Key: key,
    ResponseContentType: 'application/pdf',
    ResponseContentDisposition: 'inline',
  }), { expiresIn: expiresInSeconds });
}

module.exports = { resolveBookKey, checkBookPdf, presignBookPdf };
