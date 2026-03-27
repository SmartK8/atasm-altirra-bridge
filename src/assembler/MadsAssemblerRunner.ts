/* eslint-disable @typescript-eslint/naming-convention */
"use strict";
import * as vscode from 'vscode';
import * as path from 'path';
import * as application from '../application';
import * as filesystem from '../filesystem';
import * as execute from '../execute';

import { AssemblerRunnerBase } from './AssemblerRunnerBase';

export class MadsAssemblerRunner extends AssemblerRunnerBase {

	public DefaultMadsBin: string = "";
	private MadsPath: string = "mads";

	constructor() {
		super("Mads");
	}

	private GetMadsParams(): string | undefined {
		const specificParams = (this.BuildConfig as any)?.madsParams?.trim();
		if (specificParams && specificParams.length > 0) {
			return specificParams;
		}
		const sharedParams = this.BuildConfig?.params?.trim();
		return (sharedParams && sharedParams.length > 0) ? sharedParams : undefined;
	}
	
	protected async GetAssemblerCommandLineFromBuildInfo(): Promise<string[]> {
		let args: string[] = [];

		if (!await application.EnsureBuildConfigIsLoaded()) { return args; }

		this.BuildConfig = application.GetBuildConfig();
		if (!this.BuildConfig) { return args; }

		const configuredInput = this.ResolveInputSpecifier(this.BuildConfig.input)?.trim() ?? "";
		this.InputFileName = configuredInput.length > 0 ? configuredInput : await this.GetDefaultOrFirstAsmFilename("theapp.asm");
		this.InputFileNameBase = path.parse(this.InputFileName).name;

		this.OutputFolder = path.join("",
			(this.BuildConfig.outputFolder && this.BuildConfig.outputFolder.trim().length > 0) ? this.BuildConfig.outputFolder : "out"
		);

		this.OutputFileName = `"${path.join(this.OutputFolder, this.InputFileNameBase + ".xex")}"`;
		this.OutputSymbolsFileName = `"${path.join(this.OutputFolder, this.InputFileNameBase + ".lab")}"`;
		this.OutputListFileName = `"${path.join(this.OutputFolder, this.InputFileNameBase + ".lst")}"`;
		this.OutputBreakpoints = path.join(this.OutputFolder, this.InputFileNameBase + ".brk");
		this.OutputDebugCmds = path.join(this.OutputFolder, this.InputFileNameBase + ".atdbg");

		args.push(this.MadsPath);

		const madsParams = this.GetMadsParams();
		if (madsParams) {
			args.push(madsParams);
		}

		args.push(`-o:${this.OutputFileName}`);

		if (this.BuildConfig?.symbols && this.BuildConfig?.symbols.length > 0) {
			this.BuildConfig.symbols.map(x => args.push(`-d:${x}`));
		}

		if (this.BuildConfig?.withDebug) {
			args.push(`-t:${this.OutputSymbolsFileName}`);
			args.push(`-l:${this.OutputListFileName}`);
		}

		args.push(`"${this.InputFileName}"`);

		return args;
	}

	protected async GetAssemblerCommandLineDirectly(thisAsmFile: string): Promise<string[]> {
		this.InputFileName = thisAsmFile.length > 0 ? thisAsmFile : await this.GetDefaultOrFirstAsmFilename("theapp.asm");
		this.InputFileNameBase = path.parse(this.InputFileName).name;

		this.OutputFolder = path.join("", "out");

		this.OutputFileName = `"${path.join(this.OutputFolder, this.InputFileNameBase + ".xex")}"`;
		this.OutputSymbolsFileName = `"${path.join(this.OutputFolder, this.InputFileNameBase + ".lab")}"`;
		this.OutputListFileName = `"${path.join(this.OutputFolder, this.InputFileNameBase + ".lst")}"`;
		this.OutputBreakpoints = path.join(this.OutputFolder, this.InputFileNameBase + ".brk");
		this.OutputDebugCmds = path.join(this.OutputFolder, this.InputFileNameBase + ".atdbg");

		let args: string[] = [];
		args.push(this.MadsPath);
		args.push(`-o:${this.OutputFileName}`);
		args.push(`"${this.InputFileName}"`);

		return args;
	}

	 protected InitGetAssemblerCommandLineGetter(): void {
		this.InitOriginalPath();
		this.Configuration = application.GetConfiguration();
		this.WorkspaceFolder = this.GetWorkspaceFolder();

		if (this.Configuration) {
			let newMadsPath = this.Configuration.get<string>(`assembler.madsPath`, "").trim();
			this.MadsPath = newMadsPath?.length ? newMadsPath : this.DefaultMadsBin;
		}
		else {
			this.MadsPath = this.DefaultMadsBin;
		}
	}	

	protected async ExecuteAssemblerAsync(): Promise<boolean> {
		let command = this.MadsPath;
		let args: string[] = [];

		const madsParams = this.GetMadsParams();
		if (madsParams) {
			args.push(madsParams);
		}

		args.push(`-o:${this.OutputFileName}`);

		if (this.BuildConfig?.symbols && this.BuildConfig?.symbols.length > 0) {
			this.BuildConfig.symbols.map(x => args.push(`-d:${x}`));
		}

		if (this.BuildConfig?.includes && this.BuildConfig.includes.length > 0) {
			this.BuildConfig.includes.map(x => args.push(`-i:"${x}"`));
		}
		if (this.BuildConfig?.withDebug) {
			args.push(`-t:${this.OutputSymbolsFileName}`);
			args.push(`-l:${this.OutputListFileName}`);
		}

		args.push(`"${this.InputFileName}"`);

		let env: { [key: string]: string | null } = {};

		application.CompilerOutputChannel.appendLine(`Starting build ...`);
		application.CompilerOutputChannel.appendLine(command);
		application.CompilerOutputChannel.appendLine(args.join(" "));

		this.IsRunning = true;
		let executeResult = await execute.Spawn(command, args, env, this.WorkspaceFolder,
			(stdout: string) => {
				let result = true;
				if (stdout.includes("Parse error:") || stdout.includes("error:")) {
					result = false;
				}
				application.CompilerOutputChannel.append('' + stdout);
				return result;
			},
			(stderr: string) => {
				let result = true;
				if (stderr.includes("Permission denied")) {
					result = false;
				}
				application.CompilerOutputChannel.append('' + stderr);
				return result;
			});
		this.IsRunning = false;

		if (executeResult) {
			executeResult = await this.VerifyCompiledFileSizeAsync();
		}

		return executeResult;
	}

	 private async RemoveOldOutputFilesAsync(): Promise<void> {
		let files = [
			path.join(this.WorkspaceFolder, this.OutputFileName),
			path.join(this.WorkspaceFolder, this.OutputSymbolsFileName),
			path.join(this.WorkspaceFolder, this.OutputListFileName),
			this.OutputBreakpoints,
			this.OutputDebugCmds,
		];

		for await (let fileToCheck of files) {
			if (await filesystem.FileExistsAsync(fileToCheck)) {
				await filesystem.RemoveFileAsync(fileToCheck);
			}
		}
	}

	 private async VerifyCompiledFileSizeAsync(): Promise<boolean> {
		application.WriteToCompilerTerminal(`Verifying assembler output...`);

		let files = [this.OutputFileName];
		if (this.BuildConfig?.withDebug) {
			files.push(this.OutputSymbolsFileName);
			files.push(this.OutputListFileName);
		}

		let okFiles:string[] = [];

		for await (let fileToCheck of files) {
			let fileStats = await filesystem.GetFileStatsAsync(path.join(this.WorkspaceFolder, fileToCheck));
			if (fileStats && fileStats.size > 0) {
				okFiles.push(fileToCheck);
				continue;
			}
			if (fileStats) {
				application.WriteToCompilerTerminal(`WARNING: Assembler output is empty: '${fileToCheck}'`);
			}
			else {
				application.WriteToCompilerTerminal(`ERROR: Failed to create file: '${fileToCheck}'`);
			}
		}
		if (okFiles.length) {
			application.WriteToCompilerTerminal(`Generated files:[${okFiles.join(", ")}] are ok`);
		}

		return true;
	}

	private async MakeOutputFolder(): Promise<boolean> {
		let folder = path.join(this.WorkspaceFolder, this.OutputFolder);
		if (!await filesystem.FolderExistsAsync(folder)) {
			return await filesystem.MkDirAsync(folder);
		}

		return true;
	}

	protected InitOriginalPath(): void {
	}

	protected async InitialiseAsync(): Promise<boolean> {
		let result = true;
		this.InitOriginalPath();
		this.Configuration = application.GetConfiguration();
		this.WorkspaceFolder = this.GetWorkspaceFolder();

		if (this.Configuration.get<boolean>(`editor.clearPreviousOutput`)) {
			application.CompilerOutputChannel.clear();
		}	
		if (this.Configuration.get<boolean>(`editor.showAssemblerOutput`)) {
			application.CompilerOutputChannel.show();
		}

		let newMadsPath = this.Configuration.get<string>(`assembler.madsPath`, "").trim();
		this.MadsPath = newMadsPath?.length ? newMadsPath : this.DefaultMadsBin;

		this.BuildConfig = application.GetBuildConfig();
		if (!this.BuildConfig) { return false; }

		const configuredInput = this.ResolveInputSpecifier(this.BuildConfig.input)?.trim() ?? "";
		this.InputFileName = configuredInput.length > 0 ? configuredInput : await this.GetDefaultOrFirstAsmFilename("theapp.asm");
		this.InputFileNameBase = path.parse(this.InputFileName).name;

		this.OutputFolder = path.join("",
			(this.BuildConfig.outputFolder && this.BuildConfig.outputFolder.trim().length > 0) ? this.BuildConfig.outputFolder : "out"
		);
		if (!await this.MakeOutputFolder()) {
			application.WriteToCompilerTerminal(`Unable to create the output folder: ${this.OutputFolder}. This is always under the your workspace!`);
			return false;
		}

		this.OutputFileName = path.join(this.OutputFolder, this.InputFileNameBase + ".xex");
		this.OutputSymbolsFileName = path.join(this.OutputFolder, this.InputFileNameBase + ".lab");
		this.OutputListFileName = path.join(this.OutputFolder, this.InputFileNameBase + ".lst");
		this.OutputBreakpoints = path.join(this.WorkspaceFolder, this.OutputFolder, this.InputFileNameBase + ".brk");
		this.OutputDebugCmds = path.join(this.WorkspaceFolder, this.OutputFolder, this.InputFileNameBase + ".atdbg");

		if (this.IsRunning) {
			application.WriteToCompilerTerminal(`The assembler is already running! If you need to cancel the process use the 'atasm: Reset build process' option from the Command Palette.`);
			return false;
		}

		await this.RemoveOldOutputFilesAsync();

		return result;
	}

	public async FixExecPermissions(): Promise<void> {
	}
}
