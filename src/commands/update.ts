export interface UpdateOptions {
  since?: string;
  staged?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export async function update(_opts: UpdateOptions): Promise<void> {
  console.log("docsync update: not implemented yet");
}
