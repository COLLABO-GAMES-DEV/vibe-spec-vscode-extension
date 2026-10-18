# Codex 수동 수용 테스트

`scripts/codex-acceptance.mjs`는 합성 fixture 복사본에 한국어 과제 네 개를 주고 CLI 결과와 파일 변경으로 판정한다. [설계 testing.md](design/testing.md)의 수동 수용 검사이며 일반 CI에는 연결하지 않는다. 모델의 최종 설명은 통과 근거가 아니다.

## 실행

먼저 현재 변경으로 core와 CLI를 빌드한다. 선택한 CLI의 `init`이 생성하는 최신 AGENTS.md를 각 복사본에 넣으므로, AGENTS 생성 코드 변경 뒤에는 다시 빌드해야 한다.

```sh
pnpm --filter @vibe-spec/core build
pnpm --filter @vibe-spec/cli build
node scripts/codex-acceptance.mjs --dry-run
```

dry-run은 CLI 실행·원본 검사·과제별 임시 복사·Git baseline 커밋·AGENTS 교체·PATH wrapper 점검·예상 결과 생성을 수행한다. **Codex는 실행하지 않으며 결과는 `DRY_RUN_READY`/`NOT_RUN`이다. 수용 테스트 통과를 뜻하지 않는다.**

현재 AGENTS 안내와 배포 CLI를 빌드하고 준비 결과를 확인한 뒤 실제 실행한다. Codex CLI와 기존 로그인, Node.js, Git이 필요하다.

```sh
node scripts/codex-acceptance.mjs
node scripts/codex-acceptance.mjs --cli-entry /absolute/path/to/cli/main.js --timeout-seconds 300
```

CLI 진입점 우선순위는 `--cli-entry` → `VIBE_CLI_ENTRY` → 이 저장소의 `packages/cli/dist/main.js`다. 상대 인자·환경 경로는 실행한 현재 디렉터리 기준이다. PowerShell에서도 인자 방식을 사용할 수 있다.

```powershell
$env:VIBE_CLI_ENTRY = 'C:\vibe-spec\packages\cli\dist\main.js'
node scripts/codex-acceptance.mjs --dry-run
```

`--demo <folder>`로 동일한 데모 fixture 위치를 바꿀 수 있으며 기본값은 `packages/core/test/fixtures/acceptance`다. `--codex <executable>`은 Codex 실행 파일 경로만 받으며 추가 옵션 문자열을 받지 않는다. `--help`로 옵션을 확인한다.

실행 계약은 `codex exec --json --ephemeral -s workspace-write -C <copy> -`이고 한국어 과제는 stdin으로 전달한다. 모델·reasoning·사용자 설정·인증 설정은 덮어쓰지 않는다. 실행 출력은 JSONL과 stderr로 보존한다. [공식 OpenAI 비대화형 실행 문서](https://learn.chatgpt.com/docs/non-interactive-mode)

과제당 기본 제한은 300초이며 `--timeout-seconds`는 1~540초만 허용한다. timeout은 실패이며 POSIX에서는 해당 프로세스 그룹, Windows에서는 `taskkill /T /F`로 하위 프로세스까지 종료한다. 종료 확인에도 짧은 제한을 둔다. 다른 과제는 각자 새 baseline에서 계속된다. 전체 실행은 네 과제의 제한 시간을 합친 만큼 걸릴 수 있다.

## 고정 과제와 판정

| 과제 | 정확한 목표 | 허용 변경 파일 | 검증 오류 |
| --- | --- | --- | --- |
| 숫자 한 칸 | `shop-products/shop_005/price`: `+001.2300E+0002` → 문자열 `+0008.120000E+0002` | `tables/shop-products.yaml` | 기존 3개 유지 |
| 새 행 | `shop_acceptance_001`, 수용 테스트 상품, 아이템 `demo_token_001`, 보너스 `demo_token_002`, 재화 `demo_currency_001`, 가격 문자열 `+000.1234567890123456789012345678900E+0002`, 수량 문자열 `0002`, `regular`, 메모 `새 행 원문 보존 확인` | `tables/shop-products.yaml` | 기존 3개 유지 |
| Key rename | `items/demo_token_001` → `demo_token_renamed`, 선언된 참조 6칸도 갱신, 자유 메모 유지 | `tables/items.yaml`, `tables/shop-products.yaml` | 기존 3개 유지 |
| 오류 수정 | 아래 세 칸만 정상 값으로 교체 | `tables/grade-rates.yaml`, `tables/shop-products.yaml` | 3개 → 0개 |

기존 오류는 다음과 같다. 원본 데모가 이 기준과 다르면 준비 단계에서 실패한다. runner가 원본을 reset하거나 오류를 다시 주입하지 않는다.

| 칸 | 기존 값 | 오류 코드 | 수정 과제의 목표 값 |
| --- | --- | --- | --- |
| `shop-products/shop_003/reward_item` | `missing_demo_item` | `REF_MISSING` | `demo_card_001` |
| `shop-products/shop_007/sale_type` | `archived` | `VALUE_TYPE_OR_RANGE` | `regular` |
| `grade-rates/B/chance_percent` | `120.0000` | `VALUE_TYPE_OR_RANGE` | 문자열 `35.000` |

판정은 실제 `vibe validate --json`의 종료 코드와 진단 식별자, 모든 테이블의 `read --json` 값·스키마·참조, 전체 파일 해시, Git diff와 변경 파일 목록을 비교한다. 숫자는 문자열 그대로 비교하고 행 순서만 Key 기준으로 정렬해 비교한다. 숫자 한 칸 과제는 Git diff도 한 줄 추가·한 줄 삭제여야 한다. schemas/README/AGENTS 등 범위 밖 변경과 남은 임시 요청 파일은 실패다.

각 과제는 임시 `vibe` sh·cmd wrapper를 PATH 앞에 넣는다. wrapper는 실제 선택한 CLI로 전달하고 호출·종료 코드를 기록한다. 성공한 read·편집(또는 rename)·validate 호출도 있어야 한다. Git HEAD 변경·원격 추가·CLI save/push/pull 호출, Codex 프로세스 실패·timeout·실패 이벤트는 통과시키지 않는다. JSONL의 자기평가는 읽어 성공을 판정하지 않는다.

## 격리와 결과

원본은 읽기만 한다. 과제마다 `.git`, `node_modules`, `.DS_Store`를 제외한 새 임시 복사본을 만들고 심볼릭 링크는 복사하지 않는다. 각 복사본은 현재 CLI의 `init`에서 받은 AGENTS.md를 사용하며 별도 Git baseline만 가진다. 원격은 없다. baseline 커밋은 runner의 준비 작업이고 에이전트에게는 커밋·push·제품 소스/설정 수정 금지를 명시한다.

결과는 OS 임시 디렉터리의 `vibe-codex-acceptance-*` 아래 남는다. 제품 저장소나 원본 데모 아래를 가리키는 TMPDIR/TEMP 설정은 거절한다. 자동 삭제하지 않으므로 검토 후 해당 실행 디렉터리만 직접 제거한다.

- `results.json`, `results.md`: 전체/과제별 판정과 실패 검사, 원본 변경 여부.
- `preflight.json`, `generated-guide/AGENTS.md`: 원본 검사와 실제 사용 안내.
- 각 과제의 `repo/`, `prompt.md`, `baseline.json`, `expected.json`: 독립 복사본·한국어 과제·기준·정확한 예상 결과.
- 실제 실행 후 `execution.json`, `codex.jsonl`, `codex.stderr.log`, `cli.jsonl`, `after.json`, `diff.patch`: 실행·CLI 사용·판정 증거. 준비 실패 시 일부 파일은 없을 수 있다.

종료 코드 0은 실제 실행의 전 과제 통과 또는 dry-run 준비 성공이다. 둘은 반드시 `results.json`의 `dryRun`과 `status`로 구분한다. 준비/실행/판정 실패는 종료 코드 1이다. 실패 시 우선 process·wrapper 로그로 실행 환경을, CLI 진단으로 사용성·데이터 결과를 확인하고, prompt/AGENTS와 함께 안내 문제인지 구분한다. 이 runner는 Windows의 실제 셸·샌드박스 지원이나 배포 CLI 설치 성공을 dry-run만으로 입증하지 않는다.

## 공개용 fixture

기본 fixture는 합성 아이템 4행, 상품 7행, 확률 3행으로 구성한다. 원본 게임 데이터는 포함하지 않는다. 의도한 오류 3개와 rename 대상의 참조 6개, 숫자 원문·메모 보존 조건을 유지한다. 합성 fixture의 `--dry-run`은 준비 검사이며 실제 Codex 수용 테스트 통과를 뜻하지 않는다.
