import { AppError, type FieldError } from "./repository";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const PDF_TYPE = "application/pdf";
export const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXTENSION: Record<string, string> = {
  [PDF_TYPE]: ".pdf",
  [DOCX_TYPE]: ".docx",
};
const MAGIC: Record<string, Buffer> = {
  [PDF_TYPE]: Buffer.from("%PDF-"),
  [DOCX_TYPE]: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};
const KEYS = ["fileName", "contentType", "contentBase64"];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ResumeUpload {
  fileName: string;
  contentType: string;
  content: Buffer;
}

/** Validates the `resumeFile` request field. Never includes file content or names in errors. */
export function parseResumeFile(value: unknown): ResumeUpload {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) =>
    errors.push({ field: `resumeFile.${field}`, message });
  const done = (): never => {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The uploaded resume is invalid",
      errors,
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ field: "resumeFile", message: "must be an object" });
    return done();
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!KEYS.includes(key)) fail(key, "is not allowed");

  let fileName = "";
  if (typeof input.fileName !== "string") fail("fileName", "is required");
  else {
    fileName = input.fileName.trim();
    if (!fileName || fileName.length > 200)
      fail("fileName", "must be 1 to 200 characters");
    else if (/[\\/\u0000-\u001f\u007f]/.test(fileName))
      fail("fileName", "must not contain path separators or control characters");
  }

  const contentType = input.contentType;
  const knownType =
    typeof contentType === "string" && contentType in EXTENSION
      ? contentType
      : null;
  if (typeof contentType !== "string") fail("contentType", "is required");
  else if (!knownType)
    fail("contentType", "must be application/pdf or a DOCX document");
  if (
    knownType &&
    fileName &&
    !errors.some((e) => e.field === "resumeFile.fileName") &&
    !fileName.toLowerCase().endsWith(EXTENSION[knownType]!)
  )
    fail("fileName", `must end with ${EXTENSION[knownType]}`);

  let content: Buffer | null = null;
  const encoded = input.contentBase64;
  if (typeof encoded !== "string" || !encoded)
    fail("contentBase64", "is required");
  else if (encoded.length % 4 !== 0 || !BASE64.test(encoded))
    fail("contentBase64", "must be valid base64");
  else {
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if ((encoded.length / 4) * 3 - padding > MAX_RESUME_BYTES)
      fail("contentBase64", "must be at most 5 MB");
    else {
      content = Buffer.from(encoded, "base64");
      if (!content.length) fail("contentBase64", "must not be empty");
      else if (
        knownType &&
        !content.subarray(0, MAGIC[knownType]!.length).equals(MAGIC[knownType]!)
      )
        fail("contentBase64", "does not match the declared file type");
    }
  }
  if (errors.length || !content || !knownType) return done();
  return { fileName, contentType: knownType, content };
}

/** RFC 5987/8187 encoded Content-Disposition for a download. */
export function attachmentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}
