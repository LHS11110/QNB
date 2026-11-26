# QNB · Proof Workspace

QNB는 계정별 Cloud Hypervisor VM에서 파일을 편집하고 Lean 4와 Python Jupyter 셀을 실행하는 웹 IDE입니다. Lean에서 검증된 이름 있는 정리의 소스와 SHA-256 해시를 SQLite에 저장하고, Neo4j의 의존 관계를 브라우저에 표시합니다.

## 실행

Linux KVM 호스트에 Docker Compose와 [hypervisor-for-agora](../hypervisor-for-agora)의 런타임 관리자가 필요합니다. 해당 저장소의 **캔버스별 NAT 코드 실행**, **Canvas Jupyter notebooks**, **Lean 4 / Rocq notebook cells** 절차에 따라 게스트 이미지와 관리자를 준비하세요. QNB는 파일 서비스, IPython 커널, Lean **4.10.0**을 포함한 게스트를 사용합니다. 기본 관리자 소켓은 `/run/agora-runtime/manager.sock`이며 웹 컨테이너의 UID/GID는 기존 관리자 소켓 그룹에 맞춘 `10001:10001`입니다.

1. 같은 관리자를 쓰는 배포와 겹치지 않는 VM ID 범위를 확보합니다. 기본 범위는 `1900000000`부터 `1900000031`까지입니다. 다른 범위가 필요하면 시작하기 전에 `QNB_VM_ID_BASE`와 `QNB_VM_ID_COUNT`를 지정합니다.
2. QNB 디렉터리에서 `docker compose up -d --build`를 실행합니다.
3. [http://localhost:8765](http://localhost:8765)에서 가입하고 워크스페이스를 엽니다. 첫 파일 요청에서 VM이 준비되며 이미지 복사와 부팅에 시간이 걸릴 수 있습니다.

| 환경 변수 | 용도 |
| --- | --- |
| `QNB_PORT` | 루프백 웹 포트. 기본값 8765 |
| `QNB_VM_SOCKET_DIR` | 호스트의 관리자 소켓 디렉터리 |
| `QNB_VM_ID_BASE`, `QNB_VM_ID_COUNT` | 계정에 할당할 전용 VM ID 범위 |
| `QNB_VM_DISK_GIB` | VM 최소 디스크 크기. Lean이 포함된 게스트 기본값은 12 GiB |
| `QNB_SECURE_COOKIE` | HTTPS 프록시 뒤에서 실행할 때 `1` 설정 |
| `QNB_BATCH_SIZE` | 증명 관련 레코드를 PostgreSQL에 보낼 배치 크기. 기본값 100건 |
| `QNB_BATCH_INTERVAL` | 미반영 레코드가 배치 크기보다 적을 때 가장 오래된 레코드의 대기 시간(초). 기본값 30초 |

계정, 세션, 정리 원본, VM ID 할당은 `qnb-data` 볼륨에 저장됩니다. 파일은 호스트 런타임이 보관하는 VM 디스크에 저장되며 그래프는 `neo4j-data` 볼륨에 저장됩니다. 증명 레코드와 Lean 복원용 아카이브는 `postgres-data` 볼륨에도 배치로 영속화됩니다. 기존 VM을 유지하거나 복구할 때는 동일한 SQLite 볼륨과 ID 범위를 함께 사용하세요. Neo4j는 내부 Compose 네트워크에서 접근하며 PostgreSQL은 배치 워커와 공유하는 Unix 소켓에서 접근합니다. 주어진 호스트에서 동시에 실행하거나 보관할 수 있는 VM 수는 관리자 한도를 따릅니다.

## qnb.p-e.kr HTTPS 배포

공용 443 포트는 호스트 Nginx의 SNI 라우터가 사용합니다. QNB는 이 라우터에서 TLS 연결을 받아 루프백의 Compose 웹 서비스로 전달합니다. 아래 설정은 기본 `QNB_PORT=8765`를 사용합니다.

1. `QNB_SECURE_COOKIE=1 docker compose up -d --build`로 시작합니다. 이후 Compose로 다시 배포할 때도 같은 값을 전달하거나 프로젝트의 `.env`에 저장합니다.
2. 다음 명령으로 HTTP 리다이렉트와 인증서 검증 경로를 설정하고 Let's Encrypt 인증서를 발급합니다.

   ```bash
   sudo install -d -m 0755 /var/www/qnb-acme
   sudo install -m 0644 deploy/nginx/qnb-http.conf /etc/nginx/sites-enabled/qnb-http.conf
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot certonly --webroot -w /var/www/qnb-acme --cert-name qnb.p-e.kr -d qnb.p-e.kr
   ```

3. TLS 가상 호스트와 SNI 경로를 등록합니다. `sudoedit /etc/nginx/streams-enabled/agora-media.conf`로 파일을 열고 `$agora_tls_upstream`의 기존 `map` 블록 안에 다음 `include` 줄을 한 번 추가합니다.

   ```nginx
   include /etc/nginx/snippets/qnb-sni.map;
   ```

   ```bash
   sudo install -m 0644 deploy/nginx/qnb-sni.map /etc/nginx/snippets/qnb-sni.map
   sudo install -m 0644 deploy/nginx/qnb-https.conf /etc/nginx/sites-enabled/qnb-https.conf
   sudo nginx -t && sudo systemctl reload nginx
   curl -I http://qnb.p-e.kr/
   curl -fsS https://qnb.p-e.kr/ -o /dev/null
   ```

   기존 배포에서는 웹 컨테이너를 교체하기 전에 `qnb-https.conf`를 다시 설치하고 Nginx를 리로드합니다. 이 설정이 `/api/vm/ws`의 WebSocket 업그레이드를 전달합니다.

4. 호스트의 Certbot 예약 갱신을 확인하고, 인증서 갱신 시 Nginx가 새 인증서를 읽도록 배포 훅을 추가합니다.

   ```bash
   sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
   printf '%s\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' |
     sudo tee /etc/letsencrypt/renewal-hooks/deploy/qnb-reload-nginx >/dev/null
   sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/qnb-reload-nginx
   sudo certbot renew --cert-name qnb.p-e.kr --dry-run
   ```

## 노트북과 정리

브라우저는 파일 목록 조회, 파일 열기·저장, 파일·폴더 생성·이름 변경·삭제, 셀 실행, Python 환경 준비와 커널 재시작에 `/api/vm/ws`를 사용합니다. 운영 환경에서는 Nginx를 통해 WSS로 연결합니다. 요청 중 연결이 끊기면 중복 작업을 방지하기 위해 자동으로 다시 보내지 않습니다. QNB 서버는 호스트 VM 관리자와 기존 Unix 소켓으로 통신합니다.

큰 파일 전송에는 이 변경이 포함된 `hypervisor-for-agora/runtime/guest/workspace.py`가 필요합니다. 관리자 권한으로 이 파일을 호스트의 `/usr/local/lib/agora-hypervisor/guest/workspace.py`에 설치하면 기존 에이전트 갱신 절차가 정지된 VM의 다음 부팅 때 적용합니다. 실행 중인 VM은 작업을 저장한 뒤 재시작해야 합니다.

- 파일 탐색기에서 UTF-8 파일과 `.ipynb`를 최대 8 MiB까지 열고 저장할 수 있습니다. 128 KiB를 넘는 파일은 96 KiB씩 전송합니다. VM은 모든 조각을 받은 뒤 파일 버전을 확인하고 원본을 한 번에 교체합니다. 연결이 끊기면 처음부터 다시 저장할 수 있습니다.
- **새 노트북**에서 Lean 4 예제를 열고 **실행**을 누릅니다. 각 코드 셀에서 커널을 선택할 수 있습니다. Python의 실행 상태는 같은 파일 경로의 Jupyter 커널에 유지되며 **Python 재시작**으로 초기화할 수 있습니다.
- Python 셀에서 Matplotlib의 `plt.show()`를 호출하면 셀 아래에 그림이 표시됩니다. PNG, JPEG, SVG 이미지 출력을 지원하며, 노트북에 저장된 이미지도 파일을 다시 열 때 표시합니다.
- Lean은 선택한 셀의 코드만 실행합니다. 앞 셀에서 선언한 이름을 사용하려면 해당 셀을 먼저 실행해 DB에 저장하세요. 셀을 옮겨도 실행 순서는 바뀌지 않습니다. 노트북 수준 Lean 커널 메타데이터와 기존 Agora의 `%%lean4` 매직도 인식합니다. Python과 Lean을 섞은 노트북의 셀별 커널 정보는 `qnb_language` 메타데이터에 기록합니다. [Jupyter Notebook 형식](https://nbformat.readthedocs.io/en/latest/format_description.html)
- `identity` 셀을 실행해 저장한 뒤 새 Lean 셀에서 `theorem agrees (n : Nat) : n = n ∧ True := ⟨identity n, True.intro⟩`를 실행하면 `agrees → identity`를 볼 수 있습니다. 그래프는 명제나 증명항이 직접 참조한 정리와 Lean이 수집한 공리 의존성을 표시합니다. 저장된 정리 노드를 선택하면 원본과 해시를 확인할 수 있습니다.
- 해시는 Lean이 보고한 선언 범위의 UTF-8 소스에 대해 계산합니다. 동일 선언과 동일 의존 관계를 다시 검사해도 기록은 중복되지 않습니다. `sorry`나 사용자 정의 공리에 의존하는 정리는 저장 대상에서 제외합니다. 검증은 설치된 Lean 도구체인과 VM에서 가져온 컴파일 모듈을 신뢰합니다.
- 정리와 아카이브를 기록하는 트랜잭션에서 파일 기반 SQLite의 동기화 큐도 갱신합니다. 크기 또는 시간 조건이 충족되면 워커가 전송할 정리와 아카이브 레코드를 SQLite `:memory:` 테이블에 적재하고 PostgreSQL에 배치와 진행 지점을 한 트랜잭션으로 커밋합니다. 기존 레코드도 같은 경로로 동기화되며, 워커가 재시작되거나 DB 연결이 끊기면 디스크 큐에서 미완료 배치를 다시 만들 수 있습니다.
- 같은 계정에서 Lean이 해석한 명제가 동일하면 처음 저장한 정리를 재사용합니다. 연산자 표기, 바인더 이름, 유니버스 이름이 달라도 같은 명제가 될 수 있습니다. 다른 이름은 노트북 복원용 아카이브에 등록되므로 이후 증명에서 참조할 수 있습니다. 로컬 선언에 의존하는 명제는 같은 아카이브 안에서 비교합니다.
- [정리 중복 제거 예제](examples/theorem-deduplication.lean)를 Lean 셀에서 실행하면 새 계정에는 두 정리가 저장되고 그래프에 `qnbReflAndTrue → qnbRefl` 관계가 표시됩니다.
- **정리 그래프**는 편집기에서 열거나 `/proofs` 페이지에서 볼 수 있습니다. 원형 노드의 크기는 연결 수를 나타냅니다. 그래프를 끌어 이동하고 휠이나 버튼으로 확대할 수 있습니다. **최대 노드**와 **최대 깊이**의 기본값은 30개와 3입니다. 기준 정리는 깊이 0으로 세며, 조회 한도로 관계가 생략되면 화면에 표시됩니다.
- 편집기 상단의 **터미널**을 누르면 파일을 열어 둔 채 하단 패널에서 계정 VM의 `/workspace` 셸을 사용할 수 있습니다. 패널을 닫으면 셸이 종료됩니다.
- IDE는 파일과 커널 요청에 하나의 WebSocket을 재사용하고 큰 파일은 조각 단위로 전송합니다. 터미널은 전용 WebSocket에서 입력과 VM의 PTY 출력을 실시간으로 주고받습니다.
- 편집기가 열린 동안 VM의 현재 폴더와 열린 파일을 주기적으로 확인합니다. 터미널에서 생성하거나 삭제한 파일은 탐색기에 자동 반영됩니다. 저장하지 않은 탭에 외부 변경이 생기면 브라우저의 편집 내용을 유지하고 알림을 표시합니다.
- Markdown 셀은 문서로 표시됩니다. **편집**을 누르면 원문과 미리 보기를 함께 볼 수 있으며, **렌더링** 또는 `Shift+Enter`로 문서 보기로 돌아갑니다. 코드 셀에서 `Shift+Enter`는 선택한 Lean 4 또는 Python 커널로 실행합니다. 셀 유형을 바꾸거나, 선택한 셀 아래에 새 셀을 삽입할 수 있습니다.
- Neo4j에는 SQLite에 기록된 기존 정리 참조와 새로 검증한 정리에서 Lean이 수집한 표준 공리 의존성을 반영합니다. 이전에 기록하지 않은 공리 의존성은 해당 노트북을 다시 실행하면 수집됩니다. [Neo4j Query API](https://neo4j.com/docs/query-api/current/query/)

## 저장된 Lean 선언 재사용

Lean이 셀에서 해석할 수 없는 이름을 보고하면 현재 계정의 SQLite 저장 기록을 조회합니다. 정리와 보조 정리는 처음 검증할 때 Lean이 확정한 명제를 저장합니다. 동일한 전체 이름으로 여러 기록이 있으면 최근 저장본을 사용합니다.

다른 셀이나 노트북에서 `identity`를 사용하면 QNB는 저장된 원본을 다시 검사하고, 증명항을 가진 정리로 현재 Lean 환경에 추가합니다. `def`·`abbrev`·`opaque` 같은 정의도 본문과 함께 복원합니다. Lean이 확인할 수 없고 계정 DB에도 없는 이름은 Lean 오류로 반환됩니다. 셀은 기본적으로 `autoImplicit`을 끄므로 변수는 바인더나 `variable`로 명시하세요. 그래프 간선은 기존에 저장된 정리 기록을 가리킵니다.

커널이 확정한 명제가 들어 있지 않은 이전 기록은 원본 노트북을 한 번 실행해 갱신할 수 있습니다. 가져온 Lean 모듈은 실행 VM에서 사용할 수 있어야 합니다.

## 코드 의존성 그래프

상단의 **코드 의존성** 또는 탐색기 하단의 **코드 의존성 그래프**를 누르면 VM 워크스페이스의 Python(`.py`), C++(`.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hpp` 등), Java(`.java`) 소스를 분석해 다음 관계를 그래프로 표시합니다. 분석 경로에 폴더나 파일 하나를 지정할 수 있으며 기본값은 현재 탐색기 폴더입니다.

| 노드 | 의미 |
| --- | --- |
| 파일 (사각형) | 소스 파일 |
| 클래스 (마름모) | Python 클래스, C++ `class`/`struct`/`enum`, Java 클래스·인터페이스·열거형·레코드 |
| 함수 (원) | 함수, 메서드, 생성자 |
| 변수 (작은 원) | 모듈/네임스페이스 전역 변수, 클래스 필드, `self.x` 인스턴스 속성, 열거형 상수 |

간선은 `import`(Python `import`, C++ `#include`, Java `import`와 같은 패키지), 호출, 읽기, 쓰기, 상속, 포함/선언을 구분합니다. Python은 표준 `ast` 모듈로 분석하고 지역 변수가 전역 이름을 가리는 경우를 고려합니다. C++과 Java는 주석과 문자열을 제거한 뒤 중괄호 구조와 토큰 패턴으로 선언과 참조를 추정하므로, 매크로나 템플릿 메타프로그래밍, 타입 추론이 필요한 `obj.method()` 호출은 일부 놓칠 수 있습니다. 같은 이름의 메서드가 프로젝트에 하나뿐이면 수신 객체의 타입을 모르더라도 연결합니다. C++ 헤더의 선언과 소스의 정의는 하나의 노드로 합쳐집니다.

언어·노드·관계 필터와 **선택 노드 주변만** 보기로 큰 그래프를 좁힐 수 있고, 노드를 선택하면 들어오고 나가는 의존 관계를 확인하고 정의 위치의 파일을 바로 열 수 있습니다. 한 번에 최대 400개 파일, 4 MiB까지 분석하며 `.git`, `node_modules`, `__pycache__`, `build`, `target` 같은 폴더와 숨김 폴더는 건너뜁니다.

## 검사

```bash
python3 -m unittest discover -s tests -v
QNB_TEST_LEAN=/usr/local/lib/agora-hypervisor/guest/proof-tools/lean/bin/lean \
  python3 -m unittest discover -s tests -v
node --check qnb/static/app.js
docker compose config --quiet
```

구현은 `hypervisor-for-agora/runtime`의 관리자·워크스페이스·노트북 프로토콜과 IRADE의 증명 기록 흐름을 참고합니다.
