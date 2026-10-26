# vibe-spec

[![Check](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension/actions/workflows/check.yml/badge.svg)](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension/actions/workflows/check.yml)

라이선스 미정 — `UNLICENSED`.

[소스 저장소](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension) · [이슈](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension/issues)

Git 저장소의 YAML 테이블과 Markdown 문서를 원본으로 쓰는 게임 기획 도구입니다. [설계 계약](docs/design/README.md)에 따라 core·CLI 읽기/쓰기와 VS Code 표·문서 블록 편집을 제공합니다.

## 개발과 실행

Node.js 24 또는 26 이상과 pnpm 12.5.1을 사용합니다.

```sh
pnpm install
pnpm check
pnpm --silent vibe init /tmp/my-planning --json
pnpm --silent vibe validate --project /tmp/my-planning --json
```

`pnpm check`는 빌드, TypeScript 검사, core 계약 테스트, 실제 CLI 프로세스 e2e를 실행합니다. GitHub의 일반 push·PR에서는 Linux의 core·CLI, Playwright 1회, 실제 VS Code 검사를 실행합니다. Windows 전체 검사는 출시 `v*` 태그의 배포 검사 또는 수동 Check 실행에서만 수행합니다. 소스 변경 후 CLI만 실행하려면 먼저 `pnpm build`를 실행합니다.

```text
packages/
├── core/src/       YAML·Markdown 보존·검증·편집·이관·Git 병합
├── core/test/      계약 테스트와 작은 기획 fixture
├── cli/src/        core를 호출하는 명령 진입점
├── cli/test/       임시 기획 폴더의 실제 CLI e2e
├── vscode/        확장 host·사이드바·파일 감시·실제 VS Code 테스트
└── webview/       React 가상 표·메시지 계약·브라우저 개발 host·Playwright
```

## 현재 CLI

```sh
pnpm --silent vibe read items --project packages/core/test/fixtures/project --json
pnpm --silent vibe read offers/bundle/price --project packages/core/test/fixtures/project --json
pnpm --silent vibe read 'offers/*/currency' --project packages/core/test/fixtures/project --json
pnpm --silent vibe fmt --project /tmp/my-planning --check --json
pnpm --silent vibe fmt --project /tmp/my-planning --json
```

`init`는 빈 폴더에 `schemas/`, `tables/`, `.vibe-spec.json`, `.gitignore`, `.gitattributes`, `AGENTS.md`를 만듭니다. 기존 `.git`만 있는 폴더도 허용합니다. 테이블은 화면이나 `edit`로 스키마와 함께 만들 수 있습니다. `--project`를 생략하면 현재 폴더부터 상위의 `.vibe-spec.json`을 찾습니다.

JSON 출력은 `{ok, revision, data, diagnostics}`이며 작업 오류에는 `error: {code, message}`가 붙습니다. 숫자 값은 문자열입니다. 종료 코드는 성공 `0`, 검증 오류 또는 `fmt --check`의 변경 필요 `1`, 잘못된 요청·I/O 실패 `2`입니다. `fmt`의 `data.changed`는 변경된 파일 목록이며, 검증 오류가 남아 있으면 이미 포맷을 적용했어도 종료 코드가 `1`일 수 있습니다.

## 포맷과 core 계약

행 쓰기는 `edit --input change.json --expect-revision <read의 revision>`, 여러 변경은 `apply --input changes.json --expect-revision <revision>`을 사용합니다. `edit` 입력은 아래 중 한 객체, `apply` 입력은 객체 배열입니다. 공통 `--project`와 `--json`을 지원합니다.

```json
[
  {"op":"create","table":"items","row":{"code":"new_item","name":"새 아이템"}},
  {"op":"update","table":"items","key":"new_item","values":{"note":"검토 메모"}},
  {"op":"delete","table":"items","key":"consumable_potion"}
]
```

```sh
pnpm --silent vibe where-used items/currency_gold --project /tmp/my-planning --json
pnpm --silent vibe rename key items/currency_gold --to currency_coin --expect-revision <revision> --project /tmp/my-planning --json
pnpm --silent vibe rename table items --to goods --expect-revision <revision> --project /tmp/my-planning --json
pnpm --silent vibe rename column 'items/*/name' --to source --expect-revision <revision> --project /tmp/my-planning --json
```

`apply`는 한 번의 잠금 안에서 변경 결과를 만들고 검증합니다. 일반 enum·범위 오류는 파일 반영 후 진단하며, 선언된 삭제 보호는 최종 변경 결과의 남은 참조를 기준으로 거부합니다. 잘못된 명령·이름 충돌·오래된 revision도 거부합니다. 결과의 `data.applied`와 `changed`를 확인하세요. 중간 I/O 실패에는 `partial: true`와 실제 적용 파일을 반환합니다. 여러 파일 전체의 원자성을 보장하지 않습니다.

`export --output <folder>`는 스키마 요약과 전체 행을 테이블별 Markdown으로 내보냅니다. 경로 인자를 생략하면 기획 루트 설정의 `export_directory`, 그마저 없으면 `.vibe-spec-export`를 사용합니다. 출력 폴더의 `.gitignore`로 제외되는 파생물이며 정확한 값은 `read --json`으로 조회합니다.

`where-used`는 선언된 연결 `references`와 문구 `candidates`를 구분합니다. 테이블의 자유 문자열과 기획 폴더의 Markdown·텍스트 파일을 검색합니다. rename은 선언된 연결만 갱신하고 본문 후보는 그대로 반환합니다. `apply`는 이번 요청에 따른 일괄 실행 명령이며 별도 편집 로직을 갖지 않습니다.

[파일 포맷](docs/design/format.md)의 이름·Key·참조 규칙을 사용합니다. 테이블·스키마는 `tables/`와 `schemas/`, 문서는 `documents/`의 파일이며 도메인 하위 폴더를 지원합니다. enum 선택지는 열의 `values`, 추가 유일성은 스키마의 `unique: [[열, ...]]`로 선언합니다. Key는 항상 필수·유일하고 string 또는 integer 타입이며 다른 열은 기본적으로 생략 가능하고, `null`은 `nullable: true`인 경우 허용합니다. unique는 값이 생략되거나 null인 조합을 제외하고 검사합니다.

- `parseYaml` / `serializeYaml`: 원문 바이트를 그대로 왕복합니다. 읽기는 포맷을 바꾸지 않습니다.
- `updateCell` / `applyEdits`: 일반 칸의 원문 구간을 바꿉니다. 행 생성·삭제는 YAML AST로 처리하며 기존 파일 순서를 유지합니다.
- `formatYaml` / `formattedSources`: 명시적 포맷 요청에만 줄바꿈·따옴표를 정리하며 행 순서는 바꾸지 않습니다. 두 번 적용해도 결과가 같습니다.
- `loadProject` / `readPath` / `validateProject`: 파일 revision, 경로 조회, 공통 진단을 제공합니다.
- `deletionDiagnostics`: 선언된 `on_delete: restrict`의 삭제 보호를 판정하며 `applyEdits`의 삭제에 연결되어 있습니다.
- `writeChanges`: 잠금과 revision 확인 후 기존 파일을 임시 파일로 교체합니다. 여러 파일의 원자성은 보장하지 않으며 중간 실패는 적용된 파일을 알립니다. 복구는 Git으로 합니다.

integer/decimal 값은 YAML 파싱부터 JSON 출력까지 문자열입니다. decimal.js는 비교에만 사용하며, 비교할 수 없는 값은 진단하고 원문을 보존합니다. 라이브러리가 만든 숫자 표기로 저장 원문을 바꾸지 않습니다.

## 불러오기와 저장·전송

CSV/TSV/XLSX는 `import inspect <file>` → `import plan <file> --mapping mapping.json` → `import apply --input plan.json --expect-revision <revision>` 순서로 이관합니다. 빈 첫 행·첫 열을 포함한 합성 시트 fixture가 있으며, 숫자 저장값과 화면 표시값이 다르면 미리보기에서 선택합니다. 날짜·오류·계산 결과 없는 수식 등 지원하지 않는 칸은 알려 주고 적용을 막습니다. [매핑 계약](docs/design/import.md)을 참고하세요.

```sh
pnpm --silent vibe status --project /tmp/my-planning --json
pnpm --silent vibe save --reason "보상 검토 반영" --project /tmp/my-planning --json
pnpm --silent vibe push --project /tmp/my-planning --json
pnpm --silent vibe pull --project /tmp/my-planning --json
```

저장은 기획 관리 파일만 커밋하고 올리기는 현재 브랜치의 저장 내용을 원격으로 보냅니다. 받아오기의 행 충돌은 기준/내 변경/받은 변경 중 고릅니다. 다른 파일의 staged 변경은 보존하며 force push는 하지 않습니다. [CLI 구조 편집·충돌 선택 예시](docs/design/cli.md)에 입력 형식과 revision 규칙을 정리했습니다.

## 익스텐션과 화면 테스트

```sh
pnpm --filter @vibe-spec/webview exec playwright install chromium
pnpm test:webview
pnpm test:extension
pnpm package:vsix
```

통합 테스트는 별도 사용자 데이터와 임시 workspace에서 VS Code 1.141을 실행합니다. 설치본을 쓰려면 `VSCODE_EXECUTABLE`에 실제 실행 파일 경로를 지정할 수 있습니다. Linux CI는 `xvfb-run -a pnpm test:extension`을 사용합니다. 브라우저 테스트는 Chromium이며, 가짜 host 서버가 임시 fixture에 실제 core를 호출합니다. 파일 감시 역할은 브라우저 개발 모드에서만 폴링으로 대신합니다.

브라우저 개발: `pnpm --filter @vibe-spec/webview dev` 실행 후 표시된 주소를 엽니다. `?table=items`는 5,002행, `?table=offers`는 숫자와 참조 예시입니다. 테스트·개발 host는 VSIX에 포함되지 않습니다.

패키지는 `artifacts/vibe-spec-0.8.0.vsix`에 생성되며 Git에서 제외됩니다. VS Code 1.140 이상에서 확장 화면의 `…` → **Install from VSIX…**로 설치합니다. 프로젝트 폴더를 연 뒤 왼쪽 vibe-spec에서 기획 폴더를 선택하거나 빈 폴더를 초기화하세요. 여러 workspace 폴더를 열었으면 설정을 저장할 폴더를 고릅니다. 그 폴더의 `.vibe-spec.json`에 기획 위치를 저장합니다.

칸 클릭으로 선택하고 타이핑으로 덮어쓰며 편집을 시작합니다. Enter·F2·더블클릭은 기존 값을 유지합니다. 편집 중 다른 칸을 클릭하면 수정값을 확정한 뒤 그 칸을 편집하며, 값이 그대로면 쓰기 없이 이동합니다. Enter는 확정 후 다음 행, Tab은 다음 열로 이동하고 Esc는 입력을 취소합니다. 반영 실패 시 이동하지 않고 입력과 이유를 표시합니다. 일반 검증 오류는 반영한 뒤 칸에 표시하지만 `1e` 같은 미완성 숫자는 core 판정에 따라 GUI draft로 유지합니다. 숫자는 텍스트 입력이며 참조는 Key 선택입니다. TSV 여러 칸 붙여넣기도 지원합니다.

열 너비는 화면 밖을 포함한 전체 값의 텍스트 폭으로 계산해 헤더와 모든 행이 공유합니다. 본문은 기본 최대 480px이며 헤더에 필요한 폭은 보장합니다. 넘치는 내용은 말줄임하고 툴팁·편집기로 전체를 볼 수 있습니다. Key 편집은 rename으로 연결됩니다. CLI 변경은 파일 감시로 새로 고치며, 편집 중 같은 칸이 바뀌면 두 값을 보여주고 선택받습니다.

행 머리 메뉴에서 삽입·여러 행 삭제, 헤더 메뉴에서 열 추가·설정·삭제, 헤더 드래그로 순서 변경이 가능합니다. Key 없는 새 행은 draft이며 확정한 행은 파일에 추가하고 화면의 입력 위치와 구분해 안내합니다. 사이드바에서 테이블 생성·이름 변경·삭제와 파일 불러오기를 엽니다. 저장·올리기·받아오기는 별도 상태 패널에서 제공합니다.

화면 편집은 Cmd/Ctrl+Z 및 Shift+Z로 되돌리고 다시 할 수 있습니다. 선택 칸의 타이핑·한국어 IME, TSV 복사/붙여넣기, Cmd/Ctrl+F 전체 데이터 찾기, 참조 따라가기, 보기용 정렬/필터와 로컬 열 너비를 지원합니다. 문서와 A/B안은 별도 편집 화면에서 다룹니다. 범용 Notion 변환기와 시뮬레이터는 제공하지 않습니다.

## 에이전트와 배포

VSIX에는 같은 CLI를 번들한 `dist/vibe.cjs`가 들어 있습니다. Node.js 24 이상에서 실행하며, 새 기획 폴더의 AGENTS.md에 Windows PowerShell과 macOS/Linux의 설치 위치 탐색·JSON 입력 예시·revision·종료 코드 규칙이 있습니다. 기존 기획 폴더의 안내 파일은 자동으로 덮어쓰지 않습니다.

수동 수용 검사: `node scripts/codex-acceptance.mjs --cli-entry packages/vscode/dist/vibe.cjs`. [실행과 판정 기준](docs/codex-acceptance.md)에 따라 실제 `codex exec`를 사용하고 원본 데모를 보존합니다. 일반 PR CI에는 연결하지 않습니다.

태그 기반 자동 배포와 수동 업로드는 [배포 안내](docs/publishing.md)를 참고하세요.

## 문서

[문서 설계](docs/design/documents.md)에 따라 `documents/<이름>.md`를 편집합니다. 변경한 최상위 블록만 재작성하고, 그 밖의 원문·개행·공백은 보존합니다. CLI는 `document list/read/create/edit/delete/image`, 기존 경로 `read/where-used/rename`을 제공합니다. 화면의 새 문서와 블록 편집은 같은 core를 사용합니다. 기존 importer는 유지합니다.
