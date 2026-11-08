import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app";
import {
  AppError,
  type Application,
  type ApplicationStore,
  type Caller,
} from "../src/repository";
import { SubmissionService, parseSubmission } from "../src/submission";
import { UpstreamClients } from "../src/upstreams";
import { startFixtures } from "../scripts/submission-fixtures";

const candidateId = randomUUID();
const token = "Bearer contract-test-token";
const PDF_TYPE = "application/pdf";
const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX = 5 * 1024 * 1024;
const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 1)]);
const docxBytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(100, 2),
]);
const file = (bytes: Buffer, fileName: string, contentType: string) => ({
  fileName,
  contentType,
  contentBase64: bytes.toString("base64"),
});
const pdf = () => file(pdfBytes, "Jane_Doe.pdf", PDF_TYPE);
const docx = () => file(docxBytes, "Jane Doe résumé.docx", DOCX_TYPE);

function fieldsOf(body: unknown): string[] {
  try {
    parseSubmission(body);
  } catch (e: any) {
    assert.equal(e.httpStatus, 400);
    assert.equal(e.code, "VALIDATION_ERROR");
    return e.details.map((d: { field: string }) => d.field);
  }
  assert.fail("expected validation error");
}

// Memory store with the same access rule as the Postgres repository.
function memoryStore() {
  const saved = new Map<string, Application & { _file?: any }>();
  let writes = 0;
  const authorize = (a: Application, c: Caller) => {
    const ok =
      c.role === "recruiter"
        ? c.companyId === a.companyId
        : c.userId === a.candidateId;
    if (!ok) throw new AppError(403, "FORBIDDEN", "no access");
  };
  const view = (a: Application & { _file?: any }): Application => {
    const { _file, ...rest } = a;
    return rest;
  };
  const store: ApplicationStore = {
    hasApplication: async () => saved.size > 0,
    submit: async (data, caller) => {
      writes++;
      const { resumeUpload, ...rest } = data;
      const app: Application & { _file?: any } = {
        ...structuredClone(rest),
        id: `app_${writes}`,
        candidateId: caller.userId,
        resumeFile: resumeUpload
          ? {
              fileName: resumeUpload.fileName,
              contentType: resumeUpload.contentType,
              sizeBytes: resumeUpload.content.length,
            }
          : null,
        status: "Submitted",
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [],
        _file: resumeUpload,
      };
      saved.set(app.id, app);
      return view(app);
    },
    get: async (id, c) => {
      const a = saved.get(id);
      if (!a) throw new AppError(404, "APPLICATION_NOT_FOUND", "nf");
      authorize(a, c);
      return view(a);
    },
    getResumeFile: async (id, c) => {
      const a = saved.get(id);
      if (!a) throw new AppError(404, "APPLICATION_NOT_FOUND", "nf");
      authorize(a, c);
      if (!a._file)
        throw new AppError(404, "RESUME_FILE_NOT_FOUND", "no file");
      return a._file;
    },
    mine: async () => [...saved.values()].map(view),
    applicants: async () => [...saved.values()].map(view),
    update: async () => {
      throw new Error("Not exercised");
    },
  };
  return { store, writes: () => writes };
}

async function withService(
  fn: (ctx: {
    origin: string;
    fixtures: Awaited<ReturnType<typeof startFixtures>>;
    db: ReturnType<typeof memoryStore>;
  }) => Promise<void>,
) {
  const fixtures = await startFixtures(candidateId, "job_contract");
  const sources = new UpstreamClients(fixtures.config);
  const db = memoryStore();
  const server = createApp(
    db.store,
    async () => ({ database: true, broker: false }),
    new SubmissionService(db.store, sources),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ origin, fixtures, db });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sources.close();
    await fixtures.close();
  }
}
const seeker = {
  "X-User-Id": candidateId,
  "X-User-Role": "seeker",
  Authorization: token,
  "Content-Type": "application/json",
};
const recruiter = (companyId: string) => ({
  "X-User-Id": "recruiter-1",
  "X-User-Role": "recruiter",
  "X-Company-Id": companyId,
});
const post = (origin: string, body: unknown) =>
  fetch(origin + "/api/applications", {
    method: "POST",
    headers: seeker,
    body: JSON.stringify(body),
  });

test("resumeFile validation reports one detail per field", () => {
  assert.deepEqual(fieldsOf({ jobId: "j", resumeFile: "x" }), ["resumeFile"]);
  assert.deepEqual(fieldsOf({ jobId: "j", resumeFile: {} }), [
    "resumeFile.fileName",
    "resumeFile.contentType",
    "resumeFile.contentBase64",
  ]);
  assert.deepEqual(
    fieldsOf({
      jobId: "j",
      resumeFile: { ...pdf(), contentType: "text/plain" },
    }),
    ["resumeFile.contentType"],
  );
  // declared PDF but DOCX bytes, and the reverse
  assert.deepEqual(
    fieldsOf({ jobId: "j", resumeFile: file(docxBytes, "a.pdf", PDF_TYPE) }),
    ["resumeFile.contentBase64"],
  );
  assert.deepEqual(
    fieldsOf({ jobId: "j", resumeFile: file(pdfBytes, "a.docx", DOCX_TYPE) }),
    ["resumeFile.contentBase64"],
  );
  assert.deepEqual(
    fieldsOf({
      jobId: "j",
      resumeFile: file(Buffer.from("hello world"), "a.pdf", PDF_TYPE),
    }),
    ["resumeFile.contentBase64"],
  );
  for (const fileName of [
    "",
    "   ",
    "resume.txt",
    "resume.docx", // extension does not match the PDF type
    "dir/resume.pdf",
    "dir\\resume.pdf",
    "re\nsume.pdf",
    "re\u0000sume.pdf",
    "a".repeat(197) + ".pdf",
    42,
  ])
    assert.deepEqual(
      fieldsOf({ jobId: "j", resumeFile: { ...pdf(), fileName } }),
      ["resumeFile.fileName"],
      JSON.stringify(fileName),
    );
  for (const contentBase64 of ["not base64!!", "JVBERi0", "", 5])
    assert.deepEqual(
      fieldsOf({ jobId: "j", resumeFile: { ...pdf(), contentBase64 } }),
      ["resumeFile.contentBase64"],
      String(contentBase64),
    );
  assert.deepEqual(
    fieldsOf({ jobId: "j", resumeFile: { ...pdf(), extra: 1 } }),
    ["resumeFile.extra"],
  );
});

test("resumeFile accepts PDF and DOCX, trims the name, and enforces the 5 MB limit", () => {
  const a = parseSubmission({
    jobId: "j",
    resumeFile: { ...pdf(), fileName: "  Jane_Doe.PDF  " },
  });
  assert.equal(a.resumeFile?.fileName, "Jane_Doe.PDF");
  assert.equal(a.resumeFile?.contentType, PDF_TYPE);
  assert.ok(a.resumeFile?.content.equals(pdfBytes));
  const b = parseSubmission({ jobId: "j", resumeFile: docx() });
  assert.equal(b.resumeFile?.contentType, DOCX_TYPE);
  assert.equal(parseSubmission({ jobId: "j" }).resumeFile, null);

  const big = (n: number) =>
    Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(n - 5, 7)]);
  assert.equal(
    parseSubmission({ jobId: "j", resumeFile: file(big(MAX), "a.pdf", PDF_TYPE) })
      .resumeFile?.content.length,
    MAX,
  );
  assert.deepEqual(
    fieldsOf({
      jobId: "j",
      resumeFile: file(big(MAX + 1), "a.pdf", PDF_TYPE),
    }),
    ["resumeFile.contentBase64"],
  );
  try {
    parseSubmission({
      jobId: "j",
      resumeFile: file(big(MAX + 1), "a.pdf", PDF_TYPE),
    });
  } catch (e: any) {
    assert.equal(e.details[0].message, "must be at most 5 MB");
  }
});

test("applying with an uploaded file skips the approved resume, stores the file and serves it", async () => {
  await withService(async ({ origin, fixtures, db }) => {
    // Large body (~7 MB base64) passes this route's raised JSON limit.
    const response = await post(origin, {
      jobId: "job_contract",
      coverLetter: "Hello",
      resumeFile: pdf(),
    });
    assert.equal(response.status, 201);
    const { application } = await response.json();
    assert.equal(application.resumeSource, "uploaded");
    assert.deepEqual(application.resumeFile, {
      fileName: "Jane_Doe.pdf",
      contentType: PDF_TYPE,
      sizeBytes: pdfBytes.length,
    });
    assert.equal(application.resumeSnapshot, null);
    assert.equal(application.resumeReference, null);
    assert.equal(application.matchSnapshot.score, 70);
    assert.ok(!JSON.stringify(application).includes(pdf().contentBase64));
    assert.deepEqual(
      fixtures.state.calls.map((x) => x.source),
      ["job", "match", "profile"],
    );
    assert.equal(db.writes(), 1);

    const download = await fetch(
      origin + `/api/applications/${application.id}/resume-file`,
      { headers: seeker },
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), PDF_TYPE);
    assert.equal(
      download.headers.get("content-disposition"),
      "attachment; filename*=UTF-8''Jane_Doe.pdf",
    );
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(pdfBytes));

    // The owning company's recruiter can read it; lists carry no bytes.
    const asRecruiter = await fetch(
      origin + `/api/applications/${application.id}/resume-file`,
      { headers: recruiter("co-contract") },
    );
    assert.equal(asRecruiter.status, 200);
  });
});

test("download access follows the application read rule", async () => {
  await withService(async ({ origin }) => {
    const created = await (
      await post(origin, { jobId: "job_contract", resumeFile: docx() })
    ).json();
    const id = created.application.id;
    const url = `${origin}/api/applications/${id}/resume-file`;
    const company = created.application.companyId;
    const ok = await fetch(url, { headers: recruiter(company) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), DOCX_TYPE);
    assert.equal(
      ok.headers.get("content-disposition"),
      "attachment; filename*=UTF-8''Jane%20Doe%20r%C3%A9sum%C3%A9.docx",
    );
    assert.ok(Buffer.from(await ok.arrayBuffer()).equals(docxBytes));
    assert.equal(
      (await fetch(url, { headers: recruiter("other-company") })).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          headers: { ...seeker, "X-User-Id": randomUUID() },
        })
      ).status,
      403,
    );
    const missing = await fetch(
      origin + "/api/applications/app_nope/resume-file",
      { headers: seeker },
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "APPLICATION_NOT_FOUND");
    assert.equal((await fetch(url)).status, 401);
    // Application reads and lists include metadata only.
    for (const path of ["/api/applications/mine", "/api/applications?jobId=job_contract"]) {
      const list = await (
        await fetch(origin + path, {
          headers: path.includes("mine") ? seeker : recruiter(company),
        })
      ).text();
      assert.ok(list.includes('"resumeSource":"uploaded"'));
      assert.ok(!list.includes(docx().contentBase64));
    }
  });
});

test("tailored applications still need the approved resume and report no file", async () => {
  await withService(async ({ origin, fixtures }) => {
    const created = await (
      await post(origin, { jobId: "job_contract" })
    ).json();
    assert.equal(created.application.resumeSource, "tailored");
    assert.equal(created.application.resumeFile, null);
    assert.equal(
      created.application.resumeSnapshot.sections[0].bullets[0].text,
      "Contract test resume",
    );
    assert.deepEqual(
      fixtures.state.calls.map((x) => x.source),
      ["job", "resume", "match", "profile"],
    );
    const res = await fetch(
      `${origin}/api/applications/${created.application.id}/resume-file`,
      { headers: seeker },
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "RESUME_FILE_NOT_FOUND");
  });
});

test("an upload ignores a missing approved draft but still enforces the other rules", async () => {
  await withService(async ({ origin, fixtures, db }) => {
    const { grpc } = { grpc: await import("@grpc/grpc-js") };
    fixtures.state.resumeError = grpc.status.FAILED_PRECONDITION;
    assert.equal((await post(origin, { jobId: "job_contract" })).status, 409);
    fixtures.state.requireCoverLetter = true;
    const res = await post(origin, { jobId: "job_contract", resumeFile: pdf() });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "COVER_LETTER_REQUIRED");
    fixtures.state.requireCoverLetter = false;
    assert.equal(db.writes(), 0);
    const ok = await post(origin, { jobId: "job_contract", resumeFile: pdf() });
    assert.equal(ok.status, 201);
    const again = await post(origin, { jobId: "job_contract", resumeFile: pdf() });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, "ALREADY_APPLIED");
  });
});

test("invalid files return 400 with field details and write nothing", async () => {
  await withService(async ({ origin, fixtures, db }) => {
    const res = await post(origin, {
      jobId: "job_contract",
      resumeFile: file(Buffer.from("not a pdf"), "a.pdf", PDF_TYPE),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.equal(body.error.details[0].field, "resumeFile.contentBase64");
    assert.equal(fixtures.state.calls.length, 0);
    assert.equal(db.writes(), 0);
  });
});

test("a 5 MB file (about 7 MB of JSON) is accepted, other routes keep the small body limit", async () => {
  await withService(async ({ origin }) => {
    const big = Buffer.concat([
      Buffer.from("%PDF-"),
      Buffer.alloc(MAX - 5, 7),
    ]);
    const res = await post(origin, {
      jobId: "job_contract",
      resumeFile: file(big, "big.pdf", PDF_TYPE),
    });
    assert.equal(res.status, 201);
    const status = await fetch(origin + "/api/applications/app_1/status", {
      method: "PATCH",
      headers: recruiter("co-contract"),
      body: JSON.stringify({ status: "Offer", note: "x".repeat(20000) }),
    });
    assert.equal(status.status, 400);
  });
});
