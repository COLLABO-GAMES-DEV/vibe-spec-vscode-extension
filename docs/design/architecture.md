# 아키텍처와 MVP 구현

[문서 지도](README.md) · [core 분리](decisions.md#d08) · [단순한 구현](decisions.md#d14)

## 패키지와 라이브러리

```text
packages/
├── core/       # 파일·스키마·경로·검증·편집·이름 변경
├── cli/        # core와 Git 작업을 명령으로 노출
├── vscode/     # VS Code API와 메시지 연결
└── webview/    # 브라우저에서도 실행하는 표 화면
```

TypeScript·Node.js·pnpm을 사용한다. core는 VS Code/React에 의존하지 않는다. CLI와 extension host가 같은 읽기·쓰기·검증 함수를 호출하고 Webview는 메시지로만 데이터를 주고받는다.

| 용도 | 우선 사용할 것 |
| --- | --- |
| YAML 읽기·부분 수정 | yaml의 문서/원문 정보 |
| 스키마 구조 검사 | Ajv, 값 자동 coercion은 끔 |
| 숫자 범위·유일성 비교 | decimal.js에 원문 문자열을 넘겨 비교 |
| 표 화면 | React와 기존 가상 스크롤 라이브러리 |
| 버전·병합·복구 | 시스템 Git |
| 테스트 | Vitest, 실제 CLI, @vscode/test-cli, Playwright |

decimal 객체의 문자열 출력으로 원본을 재작성하지 않는다. 라이브러리 비교가 처리하지 못한 값은 검증 계산 실패로 알리고 원문을 유지한다. [decimal.js 문서](https://mikemcl.github.io/decimal.js/)

일회성 원본 조사에는 fflate·fast-xml-parser·marked를 사용한다. 값 형변환을 끈 XML 파싱으로 저장 문자열을 읽고, 기존 표 importer와 별도 경로로 원문 메타데이터만 제공한다.

VSIX에는 같은 CLI 진입점을 단일 `dist/vibe.cjs`로 번들해 함께 제공한다. 에이전트는 설치된 확장 위치를 찾고 Node.js로 실행하므로 별도 비공개 npm 패키지를 설치할 필요가 없다. `init`의 AGENTS.md가 PowerShell과 macOS/Linux 실행 방법을 안내한다.

Webview는 VS Code 전용 전역에 직접 의존하지 않고 메시지 어댑터를 받는다. 브라우저 개발 화면·Playwright는 가짜 어댑터를 주입한다. 패키지·라이브러리의 최소 버전은 구현 시 호환성을 확인해 정하며 미리 추상화 계층을 늘리지 않는다.

## 같은 PC의 파일 쓰기

1. 읽을 때 관리 파일의 revision을 계산한다.
2. GUI와 CLI가 공유하는 잠금 파일을 잡는다.
3. 쓰기 직전에 revision을 다시 확인한다. 다르면 덮어쓰지 않고 다시 읽게 한다.
4. 파일별로 같은 디렉터리의 임시 파일에 쓰고 교체한다. Windows의 일시적인 교체 거절(EPERM/EACCES/EBUSY)은 대기 합계 최대 500ms 안에서 재시도하고, 매번 대상 원문이 그대로인지 다시 확인한다. 지속되는 잠금은 실패로 알리며 작업이 끝나면 잠금을 해제한다.
5. 중간 실패는 적용된 파일을 알리고 마지막 커밋으로 되돌린다. 새 파일·이름 변경으로 남은 파일도 커밋 상태와 대조해 정리한다.

한 쓰기 작업 안에서 실제 파일 바이트를 다시 읽어 같으면 이미 파싱한 결과를 재사용한다. 별도 영속 캐시는 없고 revision·교체 직전 원문 검사를 생략하지 않는다.

여러 파일 전체의 원자성이나 커밋 전 변경의 복구는 보장하지 않는다. 마지막 커밋으로 돌아가면 그 이후의 미저장 작업은 사라질 수 있다. 잠금을 따르지 않는 직접 파일 편집의 모든 경합을 해결하려 하지 않는다. 사용자 복구 수단은 Git이다.

다른 사람의 변경은 push·pull·Git 병합으로 처리한다. 같은 PC의 파일 감시·표시와 병합 화면은 [익스텐션](extension.md)에 둔다.

긴 파일 이름은 임시 접미사까지 파일명 한도를 넘지 않도록 임시 이름만 짧게 만든다. Windows의 Git 호출에는 해당 명령에만 `core.longpaths=true`를 적용하며 사용자 전역 설정은 바꾸지 않는다. 별도로 직접 clone할 때 긴 경로가 있다면 같은 옵션이 필요하다. [Git for Windows 안내](https://github.com/git-for-windows/build-extra/blob/main/ReleaseNotes.md#known-issues)

## MVP 구현 순서

1. Key·경로·스키마와 원문 보존 읽기/쓰기를 만든다.
2. 선언된 검증·삭제 보호·이름 변경·where-used를 연결한다.
3. 최소 CLI와 시트 이관을 연결한다.
4. 저장·push·pull·Key 기반 충돌 표시를 연결한다.
5. 수천 행 가상 스크롤 표, 파일 감시, 같은 PC의 GUI/Codex 편집을 연결한다.
6. [테스트 전략](testing.md)으로 같은 완료 흐름을 확인한다.

**MVP 완료 흐름:** 여백 시트 이관 → 표 편집·이름 변경 → 사유와 함께 저장 → 올리기·다른 클론의 변경 병합 → 충돌 해결·옛 이름 참조 검증 → CI 검증.

최소 2단계는 [기획·대안](variants.md)의 테이블 변경분·상태·비교·확정을 같은 core에 추가한다. [문서 편집](documents.md)을 같은 패키지에 추가한다. 전달 태그·추천은 후속 범위이며 예약 구현하지 않는다.
