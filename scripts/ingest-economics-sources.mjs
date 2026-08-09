throw new Error(
  "This legacy ingestion command is retired because it wrote manually maintained Economics policy data to data/normalized/economics. " +
  "Update canonical documents under policy/ and run pnpm run compile:policy instead."
);
