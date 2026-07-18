FROM nousresearch/hermes-agent:latest

# Authentication and Hermes configuration are deliberately supplied by the
# embedding application through its mounted state/config, never baked in here.
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --python /opt/hermes/.venv/bin/python3 -r /tmp/requirements.txt
COPY hermes_turn_runner.py /opt/pygmyhippo/hermes_turn_runner.py

EXPOSE 8765
ENTRYPOINT ["/opt/hermes/.venv/bin/python3", "/opt/pygmyhippo/hermes_turn_runner.py"]
