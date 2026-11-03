# 로컬 개발 안내 (Windows·macOS)

Node.js·pnpm 설치와 `pnpm install`은 [README](../README.md#개발과-실행)를 따릅니다.

## F5: Extension Development Host

1. VS Code로 저장소 루트 폴더를 엽니다.
2. **F5**를 누르거나 실행 및 디버그 → `vibe-spec: Extension Development Host`를 실행합니다.
3. `vibe-spec: build` task(`pnpm build`)가 먼저 실행되고, 새 창에 시험 기획 폴더가 열립니다. 왼쪽 vibe-spec 아이콘에서 표·문서를 확인합니다.

개발 창은 평소 VS Code와 분리된 프로필을 씁니다. 기존 확장과 설정에는 영향이 없습니다.

| 용도 | 위치 |
| --- | --- |
| 사용자 데이터 | `~/vibe-spec-dev/vscode-user-data` |
| 확장 | `~/vibe-spec-dev/vscode-extensions` |
| 시험 기획 폴더 | `~/vibe-spec-dev/sample-planning` |

시험 기획 폴더에는 합성 데이터만 들어 있습니다(`경제/items`·`경제/offers` 표, `상점 안내` 문서, 독립 복제본 `offers_B`). 다시 만들려면 Terminal → Run Task → `vibe-spec: recreate sample planning folder`를 실행하거나 아래 명령을 씁니다. 이 작업은 실제 CLI로 폴더를 만듭니다.

```sh
pnpm build
node scripts/dev-sample.mjs --force
```

## 브라우저 개발 서버

Terminal → Run Task → `vibe-spec: webview dev server`를 실행하거나 아래 명령을 씁니다.

```sh
pnpm --filter @vibe-spec/webview dev
```

브라우저에서 `http://127.0.0.1:5173/`을 엽니다. 소스를 저장하면 화면이 바로 바뀝니다. 가짜 host가 임시 fixture에 실제 core를 호출하므로, 위의 시험 기획 폴더와는 별개입니다. 표 쓰기(칸·Key·열 편집, 되돌리기)는 실제 확장과 같은 core의 `applyTableWrite`를 거치므로 규칙이 같습니다. 첫 로딩은 의존성 최적화 때문에 수십 초 걸릴 수 있습니다.

| 화면 | 주소 |
| --- | --- |
| 표 | `/?table=items` (5,002행), `/?table=offers` |
| 테이블 목록 | `/?mode=tables` |
| 문서 | `/?mode=documents&document=기획 문서` (먼저 `POST /__vibe/documents/fixture`) |
| 저장·올리기, 불러오기 | `/?mode=git`, `/?mode=import` |

fixture는 PowerShell에서 `Invoke-RestMethod -Method Post http://127.0.0.1:5173/__vibe/documents/fixture`로 넣습니다.

## Windows 참고

- VS Code task는 Windows에서 `pnpm.cmd`를 호출합니다. 기본 PowerShell 실행 정책이 `pnpm.ps1`을 막기 때문입니다. 터미널에서 직접 실행할 때도 `pnpm.cmd`를 쓰세요.
- `packages/cli/test/windows.e2e.test.ts`의 `pwsh.exe` 경우는 PowerShell 7이 설치되어 있어야 통과합니다.
- 실제 VS Code 통합 테스트: `$env:VSCODE_EXECUTABLE="$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"; pnpm.cmd test:extension`
