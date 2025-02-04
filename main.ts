import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';

/**
 * プラグイン設定用インターフェース
 */
interface LocalServerSettings {
	host: string;
	port: number;
	/** 公開するフォルダーの絶対パス */
	serveDir: string;
	/** ホワイトリストモードを有効にすると、serveDir 内のファイルのうち、チェックリストで選択したファイルのみが配信対象となります */
	enableWhitelist: boolean;
	/** ホワイトリストに登録されたファイル（serveDir からの相対パス）のリスト */
	whitelistFiles: string[];
	/** 認証トークンを設定すると、各リクエストで "Authorization: Bearer <token>" ヘッダーが必要になります */
	authToken: string;
}

/**
 * 初期設定値
 */
const DEFAULT_SETTINGS: LocalServerSettings = {
	host: '127.0.0.1',
	port: 3000,
	serveDir: '/path/to/your/folder', // ※環境に合わせて変更してください
	enableWhitelist: false,
	whitelistFiles: [],
	authToken: '',
};

export default class LocalServerPlugin extends Plugin {
	settings: LocalServerSettings;
	server: http.Server;
	/** serveDir の実体パス（シンボリックリンクなどを解決済み） */
	servedRealPath: string;

	async onload() {
		console.log('LocalServerPlugin loading...');
		await this.loadSettings();

		// ホスト設定のチェック（127.0.0.1 または localhost 推奨）
		if (this.settings.host !== '127.0.0.1' && this.settings.host !== 'localhost') {
			console.warn(`Warning: ホストが ${this.settings.host} に設定されています。セキュリティ上、127.0.0.1 または localhost の使用を推奨します。`);
		}

		// serveDir の実体パスを取得
		try {
			this.servedRealPath = fs.realpathSync(this.settings.serveDir);
		} catch (err) {
			console.error(`serveDirの実体パスの解決に失敗しました: ${this.settings.serveDir}`, err);
			this.servedRealPath = path.resolve(this.settings.serveDir);
		}

		// 設定画面タブの追加
		this.addSettingTab(new LocalServerSettingTab(this.app, this));

		// HTTP サーバーの作成
		this.server = http.createServer((req, res) => {
			if (!req.url) {
				res.statusCode = 400;
				res.end('Bad Request');
				return;
			}

			// 認証チェック（認証トークンが設定されている場合のみ）
			if (this.settings.authToken) {
				const authHeader = req.headers['authorization'];
				if (!authHeader || authHeader !== `Bearer ${this.settings.authToken}`) {
					res.statusCode = 403;
					res.end('Forbidden: Invalid or missing authentication token.');
					return;
				}
			}

			// 基本的な CORS ヘッダーの設定（指定ホスト・ポートからのアクセスのみ許可）
			res.setHeader('Access-Control-Allow-Origin', `http://${this.settings.host}:${this.settings.port}`);

			// URL の解析
			const parsedUrl = new URL(req.url, `http://${this.settings.host}:${this.settings.port}`);
			const pathname = decodeURIComponent(parsedUrl.pathname);

			// serveDir に対してリクエストされたファイルのフルパスを生成
			const requestedPath = path.join(this.servedRealPath, pathname);
			const normalizedPath = path.normalize(requestedPath);

			// シンボリックリンクなどを解決して実体パスを取得
			fs.realpath(normalizedPath, (err, resolvedPath) => {
				if (err) {
					res.statusCode = 404;
					res.end('Not Found');
					return;
				}

				// serveDir の実体パス内にあるかチェック（ディレクトリトラバーサル防止）
				if (!resolvedPath.startsWith(this.servedRealPath)) {
					res.statusCode = 403;
					res.end('Forbidden');
					return;
				}

				// ホワイトリストモードが有効な場合、serveDir からの相対パスが whitelistFiles に含まれているかをチェック
				if (this.settings.enableWhitelist) {
					const relativePath = path.relative(this.servedRealPath, resolvedPath);
					if (!this.settings.whitelistFiles.includes(relativePath)) {
						res.statusCode = 403;
						res.end('Forbidden: File not whitelisted.');
						return;
					}
				}

				// ファイルまたはディレクトリかを確認
				fs.stat(resolvedPath, (err, stats) => {
					if (err) {
						res.statusCode = 404;
						res.end('Not Found');
						return;
					}

					if (stats.isDirectory()) {
						// ディレクトリの場合、簡易的なディレクトリリスティングを生成
						fs.readdir(resolvedPath, (err, files) => {
							if (err) {
								res.statusCode = 500;
								res.end('Internal Server Error');
								return;
							}

							res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
							res.write(`<html><head><meta charset="utf-8"><title>Directory Listing</title></head><body>`);
							res.write(`<h1>Index of ${pathname}</h1>`);
							res.write('<ul>');
							if (pathname !== '/') {
								const parent = path.posix.dirname(pathname);
								res.write(`<li><a href="${parent}">..</a></li>`);
							}
							files.forEach(file => {
								const filePath = path.posix.join(pathname, file);
								res.write(`<li><a href="${filePath}">${file}</a></li>`);
							});
							res.write('</ul></body></html>');
							res.end();
						});
					} else if (stats.isFile()) {
						// ファイルの場合、ストリームで返す
						const stream = fs.createReadStream(resolvedPath);
						stream.on('open', () => {
							const ext = path.extname(resolvedPath).toLowerCase();
							let contentType = 'application/octet-stream';
							if (ext === '.html' || ext === '.htm') contentType = 'text/html';
							else if (ext === '.js') contentType = 'application/javascript';
							else if (ext === '.css') contentType = 'text/css';
							else if (ext === '.json') contentType = 'application/json';
							else if (ext === '.png') contentType = 'image/png';
							else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
							else if (ext === '.gif') contentType = 'image/gif';
							else if (ext === '.svg') contentType = 'image/svg+xml';
							res.writeHead(200, { 'Content-Type': contentType });
							stream.pipe(res);
						});
						stream.on('error', (error) => {
							res.statusCode = 500;
							res.end('Internal Server Error');
						});
					} else {
						res.statusCode = 403;
						res.end('Forbidden');
					}
				});
			});
		});

		this.server.listen(this.settings.port, this.settings.host, () => {
			console.log(`Local server started at http://${this.settings.host}:${this.settings.port}`);
			console.log(`Serving folder: ${this.servedRealPath}`);
		});
	}

	onunload() {
		console.log('LocalServerPlugin unloading...');
		if (this.server) {
			this.server.close(() => {
				console.log('Local server stopped.');
			});
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/**
 * プラグイン設定画面の定義
 */
class LocalServerSettingTab extends PluginSettingTab {
	plugin: LocalServerPlugin;

	constructor(app: App, plugin: LocalServerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 指定されたディレクトリ内の全ファイル（再帰的）の相対パスリストを取得する
	 */
	private listFilesRecursive(dir: string, baseDir: string): string[] {
		let results: string[] = [];
		const list = fs.readdirSync(dir);
		list.forEach(file => {
			const fullPath = path.join(dir, file);
			const stat = fs.statSync(fullPath);
			if (stat && stat.isDirectory()) {
				results = results.concat(this.listFilesRecursive(fullPath, baseDir));
			} else {
				results.push(path.relative(baseDir, fullPath));
			}
		});
		return results;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Local Server Plugin Settings' });

		new Setting(containerEl)
			.setName('Host')
			.setDesc('ローカルサーバーのホスト名（例：127.0.0.1 推奨）')
			.addText(text =>
				text
					.setPlaceholder('127.0.0.1')
					.setValue(this.plugin.settings.host)
					.onChange(async (value) => {
						if (value !== '127.0.0.1' && value !== 'localhost') {
							console.warn('セキュリティ上、ホストは127.0.0.1またはlocalhostの使用を推奨します。');
						}
						this.plugin.settings.host = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Port')
			.setDesc('ローカルサーバーのポート番号（例：3000）')
			.addText(text =>
				text
					.setPlaceholder('3000')
					.setValue(this.plugin.settings.port.toString())
					.onChange(async (value) => {
						const port = Number(value);
						if (!isNaN(port)) {
							this.plugin.settings.port = port;
							await this.plugin.saveSettings();
						}
					})
			);

		// Serve Folder の設定（テキスト入力＋フォルダ選択ボタン）
		new Setting(containerEl)
			.setName('Serve Folder')
			.setDesc('公開するフォルダーの絶対パスを設定します。OSのフォルダ選択ダイアログも利用できます。')
			.addText(text =>
				text
					.setPlaceholder('/path/to/your/folder')
					.setValue(this.plugin.settings.serveDir)
					.onChange(async (value) => {
						this.plugin.settings.serveDir = value;
						await this.plugin.saveSettings();
						this.display(); // UI の再描画
					})
			)
			.addExtraButton(button => {
				button.setIcon('folder-open');
				button.setTooltip('Select Folder');
				button.onClick(async () => {
					// OSのフォルダ選択ダイアログを試行（※Obsidian標準ではサポートされないため、HTMLの input 要素を利用）
					const inputEl = createEl('input', { type: 'file', attr: { webkitdirectory: 'true' } });
					inputEl.onchange = async (e: Event) => {
						// @ts-ignore
						const files = inputEl.files;
						if (files && files.length > 0) {
							// 最初のファイルのディレクトリを利用
							const file0 = files[0] as any; 
							if (file0.path) { // path プロパティが存在するか確認
								this.plugin.settings.serveDir = path.dirname(file0.path);
								await this.plugin.saveSettings();
								this.display();
							}
						}
					};
					inputEl.click();
				});
			});

		// ホワイトリストの有効/無効設定
		new Setting(containerEl)
			.setName('Enable Whitelist')
			.setDesc('有効にすると、フォルダー内のファイルのうち、チェックリストで選択したファイルのみが配信されます。')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.enableWhitelist)
					.onChange(async (value) => {
						this.plugin.settings.enableWhitelist = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// ホワイトリストのチェックリスト表示（有効の場合）
		if (this.plugin.settings.enableWhitelist) {
			containerEl.createEl('h3', { text: 'Whitelist Files (Select allowed files)' });
			let files: string[] = [];
			try {
				const realPath = fs.realpathSync(this.plugin.settings.serveDir);
				files = this.listFilesRecursive(realPath, realPath);
			} catch (err) {
				console.error('フォルダー内のファイル一覧取得に失敗:', err);
			}
			files.forEach((file) => {
				new Setting(containerEl)
					.setName(file)
					.addToggle(toggle =>
						toggle
							.setValue(this.plugin.settings.whitelistFiles.includes(file))
							.onChange(async (value) => {
								if (value) {
									if (!this.plugin.settings.whitelistFiles.includes(file)) {
										this.plugin.settings.whitelistFiles.push(file);
									}
								} else {
									this.plugin.settings.whitelistFiles = this.plugin.settings.whitelistFiles.filter(f => f !== file);
								}
								await this.plugin.saveSettings();
							})
					);
			});
		}

		// 認証トークンの設定
		new Setting(containerEl)
			.setName('Authentication Token')
			.setDesc('認証トークンを設定すると、リクエスト時に "Authorization: Bearer <token>" ヘッダーが必要になります。空欄の場合は認証なし。')
			.addText(text =>
				text
					.setPlaceholder('Your token')
					.setValue(this.plugin.settings.authToken)
					.onChange(async (value) => {
						this.plugin.settings.authToken = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
