# E-Book Generator — End-to-End Test Plan

> **Purpose:** Verify every major user-facing feature works correctly end-to-end after the current build.  
> Run each scenario in order. Mark ✅ Pass or ❌ Fail beside each step.

---

## Prerequisites

- [ ] Dev server running (`npm run dev`)
- [ ] `.env` populated with valid keys for Anthropic, Kie.ai, Exa, and Supabase
- [ ] Supabase `books` table exists (run `supabase/migrations/001_create_books.sql` if not)
- [ ] Settings page: **Mock Mode OFF**, all API keys saved

---

## Scenario 1 — Book Creation & Supabase Persistence

**Goal:** Confirm a new book is written to Supabase the moment it is created.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open the Write tab. Click **+ New** in the sidebar. | Concept form appears. Library count stays at 0. |
| 2 | Enter: Title `"Test Persistence Book"`, Author `"QA Tester"`, Genre `Technology & AI`. Leave all other fields as defaults. | Form filled. |
| 3 | Click **Generate Cover Options**. | Spinner starts. Pipeline Log shows `RESEARCH` → `DRAFTING`. |
| 4 | While generating, open Supabase Dashboard → Table Editor → `books`. | A new row with the book title is visible **before generation completes**. |
| 5 | Refresh the browser. | Book reappears in the library sidebar with the correct title. |

---

## Scenario 2 — Cover Generation & Variant Selection

**Goal:** Confirm all three design variants generate, thumbnail correctly, and switching variants redraws the canvas.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | After Scenario 1 completes Stage 2, open **Cover Studio**. | Design Variants panel shows three slots. |
| 2 | Wait for all three slots to show a cover image thumbnail. | All three thumbnails render an actual image (not "Select to generate"). |
| 3 | Click the **Dark Minimalist** variant. | Canvas redraws with the Dark Minimalist image. Active badge moves to that slot. |
| 4 | Click the **Bold Graphic** variant. | Canvas redraws again. Correct image shown. |
| 5 | Click **Regenerate Base Art**. | Spinner appears. After ~30–60 s, the active variant thumbnail updates with a new image. Canvas updates. |
| 6 | Check Supabase `books` table — row `data.coverOptions`. | The regenerated variant's `imageUrl` matches the new image. |

---

## Scenario 3 — Cover Studio Assistant

**Goal:** Confirm natural-language instructions apply to the canvas and do not show raw JSON in the chat.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | In Cover Studio, type: `"make the title color gold"` → Send. | Chat reply is a plain sentence (not raw JSON). Canvas title text changes to a gold/yellow colour. |
| 2 | Type: `"align everything to the left"` → Send. | Canvas text shifts to left alignment. Layout Controls dropdowns update to reflect the change. |
| 3 | Type: `"generate a dark misty forest illustration for the Dark Minimalist variant"` → Send. | Chat reply confirms the action. App switches to Dark Minimalist slot. Generation starts. After ~30–60 s, Dark Minimalist thumbnail updates. |
| 4 | Check Supabase — `data.coverSettings`. | `titleColor`, `alignment`, and the Dark Minimalist `imageUrl` all reflect the changes. |

---

## Scenario 4 — Chapter Writing Pipeline

**Goal:** Confirm the full writing pipeline runs and persists chapter content.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Return to the Write tab. Approve the chapter plan (Stage 3). | Stage 4 begins. Pipeline Log shows chapters being drafted one by one. |
| 2 | Wait for all chapters to reach `✓ Complete`. | All chapter rows show green checkmarks. |
| 3 | Open Supabase — `data.chapters`. | Each chapter has non-empty `content` and an `illustrationUrl`. |
| 4 | Refresh the browser. Navigate to the **Reader**. | All chapters render with correct text and illustrations. |

---

## Scenario 5 — Reader: Content Editor

**Goal:** Confirm page edits, chapter edits, and illustration regeneration all apply live and persist.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open the Reader. Hover over any page. | **✏️ Edit Page** and **📖 Edit Chapter** buttons appear in the footer. |
| 2 | Click **✏️ Edit Page**. Type: `"make this more concise"`. Click **✨ Apply Edit**. | Drawer shows "✓ Content updated." Page text changes on the canvas. |
| 3 | Hover the chapter illustration. Click **🎨 Edit Illustration**. Type: `"darker mood, deep blue tones"`. Click **🎨 Generate**. | Illustration regenerates. New image appears in the reader. |
| 4 | Click **📖 Edit Chapter** on any chapter. Click **⟳ Reconstruct from Scratch**. | Entire chapter is rewritten. New content renders across multiple pages. |
| 5 | Check Supabase — the affected chapter's `content` and `illustrationUrl` fields. | Values match what is displayed in the reader. |

---

## Scenario 6 — Export PDF

**Goal:** Confirm PDF export produces a downloadable, correctly formatted file.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | In the Reader sidebar, click **Export PDF**. | Button changes to spinner with "Generating...". |
| 2 | Wait for download (~20–60 s depending on page count). | Browser download starts. File is named `<book_title>_ebook.pdf`. |
| 3 | Open the PDF. | Cover page, TOC, and all chapters are present. Headers and footers (running title, page numbers) are visible on every page. |
| 4 | Verify no raw text like `####` or `[Mock...]` appears anywhere. | Clean prose only. |

---

## Scenario 7 — Library Persistence & Multiple Books

**Goal:** Confirm multiple books coexist and the library survives a hard refresh.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Click **+ New** in the sidebar while Book 1 is active. | Concept form clears. Book 1 stays in the library list. |
| 2 | Create Book 2: Title `"Leadership Fundamentals"`, Genre `Business`. Generate covers. | Both books appear in the sidebar. |
| 3 | Hard-refresh the browser (Ctrl + Shift + R). | Both books are still in the sidebar with correct titles and statuses. |
| 4 | Click Book 1. | All of Book 1's content (chapters, cover, settings) restores correctly. |
| 5 | Click the remove icon on Book 2. Confirm the removal dialog. Click **Remove**. | Book 2 disappears from the sidebar. Supabase table no longer has Book 2's row. |

---

## Scenario 8 — Settings: Mode Toggle

**Goal:** Confirm switching between Mock Mode and Live Mode works correctly.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Go to Settings. Turn **Mock Mode ON**. Save. | Pipeline Log badge shows `MOCK MODE`. |
| 2 | Create a new book and generate covers. | Covers generate in ~2 s with SVG placeholders. No API calls made. |
| 3 | Turn **Mock Mode OFF**. Save. | Pipeline Log badge shows `LIVE`. |
| 4 | Generate a new cover for the same book. | Real image generated via Kie.ai in 30–60 s. |

---

## Pass Criteria

All 8 scenarios must pass with zero raw JSON in the UI, zero silent failures, and all data persisted to Supabase before moving to production.

| Scenario | Status |
|----------|--------|
| 1 — Book Creation & Persistence | |
| 2 — Cover Generation & Variants | |
| 3 — Cover Studio Assistant | |
| 4 — Chapter Writing Pipeline | |
| 5 — Reader Content Editor | |
| 6 — Export PDF | |
| 7 — Library Persistence & Multiple Books | |
| 8 — Settings: Mode Toggle | |
