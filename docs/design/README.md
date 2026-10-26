# vibe-spec 설계

기획자와 개발자는 GitHub 레포의 같은 파일을 원본으로 사용한다. VS Code 익스텐션과 Codex는 같은 core/CLI로 읽고 고친다. 이 문서는 구현과 테스트가 따르는 계약이다.

[확정된 결정](decisions.md)이 우선한다. 가장 단순한 구현에서 시작하고 실제 문제가 생겼을 때만 보완한다.

## 단계

- **MVP:** Key 기반 테이블·스키마·참조, 검증, 최소 CLI, 시트 불러오기, 수천 행을 위한 가상 스크롤 표, 이름 바꾸기, 사유와 함께 저장·올리기·병합.
- **2단계:** 문서·경로 링크, 기획 상태, 기준안과 A/B 변경분, 전달 상태 계산.
- **3단계:** Notion 불러오기, 자연어·구조화 목표, 레벨링 계산·추천.
- 최소 2단계의 테이블 변경분·상태·비교·확정에 이어 [문서 블록 편집](documents.md)을 추가한다. [문서 대안 편집](document-variants.md)은 이름표 문단·섹션·문서 전체 교체를 지원한다. 전달 태그·추천은 후속 범위다. 원문 조사·이관 스킬은 범용 Notion 변환과 구분한다.
- 다음 단계의 저장 외형·명령·복구 장치를 미리 구현하지 않는다.

## 문서 지도

| 파일 | 내용 |
| --- | --- |
| [decisions.md](decisions.md) | 사람이 확정한 결정과 버린 대안 |
| [format.md](format.md) | 이름·Key, 디렉터리, 스키마·표, 경로 참조 |
| [documents.md](documents.md) | Markdown 원문 보존·블록 편집·문서 경로와 실전 이관 |
| [document-variants.md](document-variants.md) | 문서 A/B 편집: 주소 범위·원문 변경분·비교·확정 |
| [variants.md](variants.md) | 최소 2단계 변경분·상태·확정과 전달 원칙 |
| [validation.md](validation.md) | 검증 진단과 선언된 삭제 보호 |
| [cli.md](cli.md) | CLI 명령과 AGENTS.md 규칙 |
| [extension.md](extension.md) | 표·가상 스크롤·저장·병합 화면 |
| [import.md](import.md) | B2 헤더와 일회성 이관 |
| [architecture.md](architecture.md) | 패키지·라이브러리·파일 쓰기·MVP 완료 흐름 |
| [testing.md](testing.md) | 같은 완료 흐름을 검사하는 테스트 전략 |
| [open-questions.md](open-questions.md) | 남은 구현 범위와 사람의 판단 |
