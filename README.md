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
- Lean은 VM의 실행 환경이 준비됐는지 별도 요청으로 확인한 뒤 선택한 셀까지 앞선 Lean 셀을 노트북 순서대로 다시 검사합니다. 준비 요청이 시간 초과되면 재시도하며, 노트북 코드에는 별도의 실행 시간이 주어집니다. 셀을 수정하거나 이동하면 다음 실행에 반영됩니다. 노트북 수준 Lean 커널 메타데이터와 기존 Agora의 `%%lean4` 매직도 인식합니다. Python과 Lean을 섞은 노트북의 셀별 커널 정보는 `qnb_language` 메타데이터에 기록합니다. [Jupyter Notebook 형식](https://nbformat.readthedocs.io/en/latest/format_description.html)
- 예제 뒤에 Lean 셀을 추가하고 `theorem again (n : Nat) : n = n := identity n`을 실행하면 `again → identity`를 볼 수 있습니다. 그래프는 명제나 증명항이 직접 참조한 정리와 Lean이 수집한 공리 의존성을 표시합니다. 저장된 정리 노드를 선택하면 원본과 해시를 확인할 수 있습니다.
- 해시는 Lean이 보고한 선언 범위의 UTF-8 소스에 대해 계산합니다. 동일 선언과 동일 의존 관계를 다시 검사해도 기록은 중복되지 않습니다. `sorry`나 사용자 정의 공리에 의존하는 정리는 저장 대상에서 제외합니다. 검증은 설치된 Lean 도구체인과 VM에서 가져온 컴파일 모듈을 신뢰합니다.
- 정리와 아카이브를 기록하는 트랜잭션에서 파일 기반 SQLite의 동기화 큐도 갱신합니다. 크기 또는 시간 조건이 충족되면 워커가 전송할 정리와 아카이브 레코드를 SQLite `:memory:` 테이블에 적재하고 PostgreSQL에 배치와 진행 지점을 한 트랜잭션으로 커밋합니다. 기존 레코드도 같은 경로로 동기화되며, 워커가 재시작되거나 DB 연결이 끊기면 디스크 큐에서 미완료 배치를 다시 만들 수 있습니다.
- 같은 계정에서 Lean이 해석한 명제가 동일하면 처음 저장한 정리를 재사용합니다. 연산자 표기, 바인더 이름, 유니버스 이름이 달라도 같은 명제가 될 수 있습니다. 다른 이름은 노트북 복원용 아카이브에 등록되므로 이후 증명에서 참조할 수 있습니다. 로컬 선언에 의존하는 명제는 같은 아카이브 안에서 비교합니다.
- [정리 중복 제거 예제](examples/theorem-deduplication.lean)를 Lean 셀에서 실행하면 새 계정에는 두 정리가 저장되고 그래프에 `qnbReflAndTrue → qnbRefl` 관계가 표시됩니다.
- **정리 의존 그래프**는 편집기에서 열거나 `/proofs` 페이지에서 볼 수 있습니다. 기준 정리를 선택하고 **최대 노드**와 **최대 깊이**를 적용하세요. 기준 정리는 노드 한 개로 세며 깊이는 0입니다. 기본값은 노드 30개와 깊이 3이고, 조회 한도 때문에 생략된 관계가 있으면 화면에 표시됩니다.
- 편집기 상단의 **터미널**을 누르면 파일을 열어 둔 채 하단 패널에서 계정 VM의 `/workspace` 셸을 사용할 수 있습니다. 패널을 닫으면 셸이 종료됩니다.
- 편집기가 열린 동안 VM의 현재 폴더와 열린 파일을 주기적으로 확인합니다. 터미널에서 생성하거나 삭제한 파일은 탐색기에 자동 반영됩니다. 저장하지 않은 탭에 외부 변경이 생기면 브라우저의 편집 내용을 유지하고 알림을 표시합니다.
- Neo4j에는 SQLite에 기록된 기존 정리 참조와 새로 검증한 정리에서 Lean이 수집한 표준 공리 의존성을 반영합니다. 이전에 기록하지 않은 공리 의존성은 해당 노트북을 다시 실행하면 수집됩니다. [Neo4j Query API](https://neo4j.com/docs/query-api/current/query/)

## 저장된 Lean 선언 재사용

Lean이 셀에서 해석할 수 없는 이름을 보고하면 현재 계정의 SQLite 저장 기록을 조회합니다. 정리와 보조 정리는 처음 검증할 때 Lean이 확정한 명제를 저장합니다. 동일한 전체 이름으로 여러 기록이 있으면 최근 저장본을 사용합니다.

다른 노트북에서 `theorem again (n : Nat) : n = n := identity n`을 실행하면 QNB는 DB의 이전 검증 결과를 신뢰해 `identity`의 명제를 공리로 추가합니다. Lean은 공리의 타입과 새 정리의 증명을 검사합니다. 셀 출력과 Lean의 `#print axioms again`으로 사용한 공리를 확인할 수 있으며, 그래프 간선은 기존 정리 기록을 가리킵니다. `def`·`abbrev`·`opaque` 같은 정의는 본문을 복원하므로 계산이 필요한 증명에서도 사용할 수 있습니다.

커널이 확정한 명제가 들어 있지 않은 이전 기록은 원본 노트북을 한 번 실행해 갱신할 수 있습니다. 가져온 Lean 모듈은 실행 VM에서 사용할 수 있어야 합니다.

## 검사

```bash
python3 -m unittest discover -s tests -v
QNB_TEST_LEAN=/usr/local/lib/agora-hypervisor/guest/proof-tools/lean/bin/lean \
  python3 -m unittest discover -s tests -v
node --check qnb/static/app.js
docker compose config --quiet
```

구현은 `hypervisor-for-agora/runtime`의 관리자·워크스페이스·노트북 프로토콜과 IRADE의 증명 기록 흐름을 참고합니다.
