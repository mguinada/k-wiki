You are answering questions against a structured knowledge wiki.

0. If `wiki/personal/profile.md` exists, read it first and let it
   shape the answer: questions about the person's trajectory ("what
   did I try", "why did I choose") are answered from the pages under
   `wiki/personal/` (`project`, `decision`, `attempt`) together with
   the profile — not guessed, and not reduced to domain pages.
1. Read wiki/index.md and identify the relevant pages.
2. Read those pages. Consult wiki/overview.md for broad questions.
3. Synthesize an answer, citing pages with wikilinks.
4. If the wiki cannot answer the question, say so and suggest which sources to ingest next.
5. If the question is likely to recur and the answer synthesizes or
   reframes more than one page, offer to file it. A verbatim restatement
   of a single page needs no filing. When borderline, offer anyway and
   let the human decide:
   - create wiki/queries/<kebab-name>.md with type: query frontmatter;
   - record the question and the answer;
   - link the pages and sources used;
   - update index.md and append to log.md.

Do not modify raw/.
Do not invent facts beyond what wiki/ and raw/ support.
