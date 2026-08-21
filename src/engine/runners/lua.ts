import { TempFileRunner } from "./tempFile";

export class LuaRunner extends TempFileRunner {
  constructor() {
    super({ id: "interpreted", displayName: "Interpreted", runnerId: () => "interpreted:lua", runnerName: () => "Lua", language: "lua", executable: (settings) => settings.luaExecutable, fileExtension: ".lua" });
  }
}
