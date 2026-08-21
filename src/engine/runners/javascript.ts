import { TempFileRunner } from "./tempFile";

export class JavaScriptRunner extends TempFileRunner {
  constructor() {
    super({ id: "node", displayName: "Node.js", language: "javascript", executable: (settings) => settings.nodeExecutable, fileExtension: ".js" });
  }
}
