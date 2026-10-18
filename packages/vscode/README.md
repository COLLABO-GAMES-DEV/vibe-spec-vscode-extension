# vibe-spec

라이선스 미정 — `UNLICENSED`.

[소스 저장소](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension) · [문제 신고](https://github.com/COLLABO-GAMES-DEV/vibe-spec-vscode-extension/issues)

게임 기획 테이블과 문서를 VS Code에서 편집하고 Git으로 함께 관리합니다. YAML 테이블과 Markdown 문서를 원본으로 사용하며, 화면과 CLI에서 같은 데이터와 검증 규칙으로 작업합니다.

확장 ID: `ijun17.vibe-spec` · 버전: **0.7.1**

<!-- Screenshot placeholder: a table with fictional sample data, the table sidebar, and a validation error. -->

## 설치하고 시작하기

표 화면을 사용하려면 **VS Code 1.140 이상**과 **시스템 Git**이 필요합니다. CLI나 Codex로 작업할 때는 **Node.js 24 이상**도 설치하세요.

1. VS Code 확장에서 `ijun17.vibe-spec`을 찾아 설치합니다. VSIX 파일이 있다면 확장 화면의 `…` → **Install from VSIX…**에서 `vibe-spec-0.7.1.vsix`를 선택합니다.
2. 로컬 프로젝트 폴더를 열고 왼쪽 **vibe-spec** 아이콘을 누릅니다.
3. 기존 데이터가 있으면 **기획 폴더 선택**, 처음 시작하면 빈 폴더에서 **새 기획 폴더 초기화**를 선택합니다.
4. **새 테이블**로 이름과 Key 열을 정하거나 **불러오기**로 CSV·TSV·XLSX를 가져옵니다. 사이드바에서 테이블을 눌러 편집합니다.
5. 변경을 검토한 뒤 **변경 사유와 함께 저장**으로 Git 커밋을 만듭니다. 연결한 원격 저장소에는 **올리기**로 전송합니다.

사이드바의 **기획** 트리에 표와 문서가 함께 표시됩니다. **새 폴더**로 분류를 만들고 우클릭 메뉴의 이동을 사용하세요. 폴더 이동은 참조 이름과 내용을 바꾸지 않습니다.

기획 폴더는 게임 저장소 안의 하위 폴더여도 되고, 별도 Git 저장소여도 됩니다. 여러 workspace 폴더를 열었다면 기획 위치 설정을 저장할 폴더를 직접 선택합니다.

## 주요 기능

| 기능 | 할 수 있는 일 |
| --- | --- |
| 도메인 폴더 | 표·문서를 한 트리에서 분류, 실제 폴더 생성·이름 변경·이동, 접기/펼치기 유지 |
| 문서 편집 | 제목·문단·목록·표·체크박스·인용·코드·이미지의 블록 편집, 문서 경로와 테이블 셀 연결 |
| 표 편집 | 여러 칸 복사·붙여넣기, 행 추가·삭제, 찾기, 정렬·필터, 화면 편집 되돌리기·다시 하기 |
| 테이블과 열 | 테이블 생성·이름 변경, 열 추가·수정·삭제·순서 변경, 표시명과 타입 설정 |
| 검증과 참조 | 필수값·타입·범위·Key 중복 검사, 참조 대상 이동과 사용처 조회, 선언된 삭제 보호 |
| 시트 불러오기 | CSV·TSV·XLSX의 시트·헤더·Key·열 매핑을 미리 보고 적용 |
| 숫자 원문 | 일반 편집의 숫자 표기를 보존하며, XLSX 정수 숫자 셀은 이관 시 정수 문자열로 바꾸고 원문을 출처 기록에 보관 |
| 기획 검토 | 기준안 위의 A/B 변경분 비교, 기획중·컨펌 전 상태, 선택 안 확정과 대안 보관 |
| Git 협업 | 사유와 함께 로컬 저장, push·pull, Key 기반 행 충돌 비교와 선택 |
| 개발용 내보내기 | 스키마와 테이블을 Markdown으로 내보내고 CLI JSON으로 정확한 값 조회 |

칸을 선택하고 입력하면 값을 바꿉니다. Enter·F2·더블클릭은 기존 값을 유지한 채 편집을 시작하며 Esc로 취소합니다. 오류 목록을 누르면 해당 칸으로 이동합니다. 외부에서 같은 값을 바꾸거나 오래된 상태로 수정하면 충돌을 알립니다.

<!-- Screenshot placeholder: the import preview or Git conflict comparison, using fictional sample data only. -->

## 파일 저장과 Git 인증

표 편집은 기획 파일에 바로 반영됩니다. **변경 사유와 함께 저장**은 기획 관리 파일만 커밋합니다. 같은 저장소의 코드 커밋도 **올리기**에 포함될 수 있으므로 저장·올리기 화면의 전송 예정 커밋을 확인하세요. **받아오기**에서 충돌이 생기면 기준·내 변경·받은 변경을 비교해 선택합니다.

원격 주소는 시스템 Git에 설정한 값을 사용합니다. 기존 `gh` 연동이나 Git Credential Manager(GCM)의 자격증명을 이용하며, 확장이 토큰을 따로 저장하지 않습니다. GitHub HTTPS 인증이 없다면 터미널에서 다음 명령을 실행한 뒤 다시 시도하세요.

```sh
gh auth login
gh auth setup-git
```

인증이나 전송이 실패해도 이미 만든 로컬 커밋은 유지됩니다.

## CLI와 Codex에서 읽고 수정하기

확장에는 CLI 파일 `dist/vibe.cjs`가 포함되어 있습니다. 새 기획 폴더의 `AGENTS.md`에 CLI 찾기, 읽기·편집·검증 절차가 안내됩니다. `code` 명령이 PATH에 있는 터미널에서 설치 위치를 찾고 Node.js로 실행할 수 있습니다.

Windows PowerShell:

```powershell
$vibeExtension = (code --locate-extension ijun17.vibe-spec).Trim()
$vibeCli = Join-Path $vibeExtension 'dist/vibe.cjs'
node $vibeCli --help
node $vibeCli read items --project "C:\Planning" --json
```

macOS/Linux:

```sh
vibe_cli="$(code --locate-extension ijun17.vibe-spec)/dist/vibe.cjs"
node "$vibe_cli" --help
node "$vibe_cli" read items --project "/path/to/planning" --json
```

`items`와 경로는 자신의 테이블·기획 폴더로 바꿉니다. `vibe` 명령을 설정했다면 같은 인자로 `vibe read items --json`을 사용할 수 있습니다. 편집 전에는 현재 revision을 읽고, 변경 후에는 `vibe validate --json`으로 결과를 확인하세요.

## 개발용 Markdown 내보내기

명령 팔레트에서 **vibe-spec: 개발용 내보내기**(`vibe.export`)를 실행하거나 CLI를 사용합니다.

```sh
vibe export --output "./review-tables" --project "/path/to/planning" --json
```

동봉된 CLI 파일로 실행할 때는 `vibe` 대신 `node $vibeCli`(PowerShell) 또는 `node "$vibe_cli"`(macOS/Linux)를 사용합니다.

출력 위치는 `--output`, 기획 루트 `.vibe-spec.json`의 `export_directory`, 기본값 `.vibe-spec-export` 순으로 결정됩니다. 상대 경로는 기획 루트 기준입니다. 기본 설정을 바꾸려면 기존 설정을 유지하면서 다음처럼 `export_directory`를 지정합니다.

```json
{
  "planning_root": ".",
  "export_directory": ".vibe-spec-export"
}
```

내보낸 Markdown은 읽기용 파생물입니다. 원본 YAML을 수정한 뒤 다시 내보내세요. 숫자 문자열, 빈 문자열, `null`, 누락된 값의 정확한 구분이 필요하면 `vibe read items --json`을 사용합니다.

기획 목록에서 기준안과 대안을 비교하고 선택한 안을 확정할 수 있습니다. 대안 작성은 CLI를 사용합니다. 공통 수정은 기준안에서 하며, 기준안의 쟁점 값이 달라지면 이전 값·현재 값·대안 값을 보여줍니다. 기획 파일이 있는 폴더에서 기존 쓰기 명령은 `--target base`를 명시합니다.

기존 시트·Notion 내보내기의 원문 조사는 `vibe source inspect <파일> --json`으로 할 수 있습니다. 초기화한 기획 폴더의 `.agents/skills/vibe-import/SKILL.md`가 조사·질문·미리보기·적용 절차를 안내합니다. 원본이 충돌하거나 의미가 불명확하면 사람이 판단합니다. 범용 자동 Notion 변환은 제공하지 않습니다. 문서는 원문을 조사하고 필요한 링크를 확인해 일회성으로 이관합니다.

## 문서 편집

사이드바 **기획** 트리의 **+**에서 폴더·표·문서를 만듭니다. 폴더를 선택한 뒤 누르면 그 위치에 생성합니다. 문서마다 자기 이름의 탭이 열리므로 여러 문서를 나란히 볼 수 있습니다. 표·문서·폴더 이름은 숫자를 인식해 `1, 6, 11, 100` 순으로 표시합니다.

문서 전체가 하나의 편집기이므로 클릭한 곳에서 바로 입력합니다. `/` 메뉴와 기본 사이드 메뉴로 블록을 추가·삭제하고 핸들을 드래그해 이동합니다. 첫 H1이 있으면 그것을 본문 제목으로 보여주며 파일 이름은 탭에만 표시합니다.

**Ctrl/Cmd+S** 또는 **변경 사유와 함께 저장**을 실행하면 사유를 받은 뒤 문서 변경을 파일에 반영하고 Git 커밋합니다. 포커스를 옮길 때마다 저장하지 않으며 별도 적용 버튼도 없습니다. 사유 입력을 취소하면 편집 내용은 그대로 남습니다. 저장 전 문서 변경은 열린 탭의 메모리에 있으므로, 탭이나 VS Code를 닫기 전에 저장해 주세요.

저장할 때 원본과 비교해 바뀌지 않은 블록은 원문 바이트를 보존하고, 이동한 블록도 원문 조각을 재사용합니다. 변경·추가한 부분만 Markdown으로 직렬화합니다. HTML·수식·깨진 표 같은 지원 밖 구문은 편집기 안의 원문 블록에서 그대로 편집합니다. 제목 경로·문단 이름표와 연결된 테이블 셀 값도 유지합니다. 외부 변경으로 저장이 거절되면 입력을 보존하고 현재 원문을 보여줍니다.

<!-- Screenshot placeholder: document block editing and a linked table cell, with fictional content only. -->

XLSX의 정수 숫자 셀은 `1.0` 대신 `1`로 이관하므로 화면·CLI·내보내기가 같은 값을 봅니다. 숫자처럼 보이는 텍스트 셀과 소수 값은 원문 그대로입니다. 이관 행은 시트 순서를 유지하며, 표에서 정렬해도 파일 순서는 바뀌지 않습니다.
