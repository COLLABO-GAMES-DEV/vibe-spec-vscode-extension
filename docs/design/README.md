# vibe-spec 설계

기획자와 개발자는 GitHub 레포의 같은 파일을 원본으로 사용한다. VS Code 익스텐션과 Codex는 같은 core/CLI로 읽고 고친다. 이 문서는 구현과 테스트가 따르는 계약이다.

[확정된 결정](decisions.md)이 우선한다. 가장 단순한 구현에서 시작하고 실제 문제가 생겼을 때만 보완한다.

## 현재 범위와 후속 기능

표·스키마·참조·검증·CLI·일회성 이관·Git 저장/전송·문서 블록 편집을 제공한다. 비교는 [복제와 자유 편집](comparison.md)을 사용한다. 전달 상태와 레벨링 목표·계산·추천은 후속 범위이며 미리 구현하지 않는다.

## 문서 지도

| 파일 | 내용 |
| --- | --- |
| [decisions.md](decisions.md) | 사람이 확정한 결정과 버린 대안 |
| [format.md](format.md) | 이름·Key, 디렉터리, 스키마·표, 경로 참조 |
| [comparison.md](comparison.md) | 복제·자유 비교·이전 데이터 보존 |
| [documents.md](documents.md) | Markdown 원문 보존·블록 편집·문서 경로와 실전 이관 |
| [validation.md](validation.md) | 검증 진단과 선언된 삭제 보호 |
| [cli.md](cli.md) | CLI 명령과 AGENTS.md 규칙 |
| [extension.md](extension.md) | 표·가상 스크롤·저장·병합 화면 |
| [import.md](import.md) | B2 헤더와 일회성 이관 |
| [architecture.md](architecture.md) | 패키지·라이브러리·파일 쓰기·MVP 완료 흐름 |
| [testing.md](testing.md) | 같은 완료 흐름을 검사하는 테스트 전략 |
| [open-questions.md](open-questions.md) | 남은 구현 범위와 사람의 판단 |
