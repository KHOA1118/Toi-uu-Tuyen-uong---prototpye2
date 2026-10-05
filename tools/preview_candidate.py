"""Preview a separate candidate without installing the official fixture.

Only the read-only fixture GET is substituted; production assets, APIs, routing,
telemetry, simulation and solver remain unchanged.
"""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Handler, HTTPServer
from road_network.store import NetworkStore
from deployment_config import map_data_path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture',type=Path,required=True)
    parser.add_argument('--port',type=int,default=8017)
    args=parser.parse_args()
    fixture=json.loads(args.fixture.read_text(encoding='utf-8'))
    store=NetworkStore(map_data_path())
    network=store.get()
    assert fixture['source_sha256']==network['metadata']['source']['sha256']
    assert fixture['event']['edge_id'] in network['edges']
    assert all(s['osm_node_id'] in network['nodes'] for s in fixture['scenario']['stops'])
    class PreviewHandler(Handler):
        def do_GET(self):
            if self.path.split('?',1)[0]=='/api/presentation-scenario':
                return self.reply(200,fixture)
            return super().do_GET()
    server=HTTPServer(('127.0.0.1',args.port),PreviewHandler)
    server.network_store=store
    print(f'Candidate-only preview: http://127.0.0.1:{args.port}/',flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if hasattr(server,'jobs'):
            server.jobs.close()


if __name__=='__main__':
    main()
